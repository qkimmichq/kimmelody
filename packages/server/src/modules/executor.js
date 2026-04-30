// 指令执行器 — 将 Claude 的结构化输出转为具体操作

export class Executor {
  constructor({ tts, music, state, ws, preloader }) {
    this.tts = tts;
    this.music = music;
    this.state = state;
    this.ws = ws;
    this.preloader = preloader;
  }

  async execute(claudeResponse, scene = 'manual') {
    const { say, play, reason, segue } = claudeResponse;

    // 1. 解析播放队列，逐首获取直链（优先搜索匹配，不依赖 AI 提供的 ID）
    const songs = [];
    for (const item of play) {
      try {
        // 直接使用搜索匹配，然后尝试用 AI 提供的 ID 获取 URL 作为补充
        const resolved = await this._searchAndResolveSong(item);

        if (resolved) {
          // 获取歌词
          let lyric = null;
          try {
            const cached = this.state.getCachedLyric(resolved.id);
            lyric = cached || await this.music.getLyric(resolved.id);
            if (!cached && lyric) this.state.setCachedLyric(resolved.id, lyric);
          } catch {
            lyric = { lrc: '', tlrc: '' };
          }

          // 获取更多详情（album 等）
          let detail = null;
          try {
            detail = await this.music.getSongDetail(resolved.id);
          } catch {
            // fallback to resolved data
          }

          songs.push({
            id: resolved.id,
            title: detail?.title || resolved.title || item.title || '未知歌曲',
            artist: detail?.artist || resolved.artist || item.artist || '未知歌手',
            album: detail?.album || '',
            cover: detail?.cover || resolved.cover || '',
            duration: detail?.duration || resolved.duration || 0,
            url: resolved.url,
            lyric,
          });
        } else {
          console.warn(`[Executor] 未找到可播放版本: ${item.title || item.id}`);
        }
      } catch (err) {
        console.warn(`[Executor] 跳过歌曲 ${item.id || item.title}: ${err.message}`);
      }
    }

    if (songs.length === 0) {
      console.warn('[Executor] 所有歌曲获取失败');
      // 即使无歌曲也返回播报，告知用户
      return { songs: [], ttsUrl: null, say: say || '暂时没有找到可以播放的音乐，稍后再试试吧' };
    }

    // 2. 设置当前会话并立即广播（不等 TTS，让歌曲先播放）
    const session = {
      songs,
      currentIndex: 0,
      currentSong: songs[0],
      ttsUrl: null,
      ttsText: say,
      ttsWords: [],
      segueTtsUrl: null,
      segueTtsText: segue || null,
      segueTtsWords: [],
      sayText: say,
      segueText: segue,
      scene,
      startedAt: Date.now(),
      isPlaying: true,
    };
    this.state.setCurrentSession(session);
    this.state.setQueue(songs);

    this.preloader?.onSongChange(0, songs);

    // 先推送歌曲信息，让前端立即开始播放音乐
    this._broadcast(session, 'song:change');

    // 3. TTS 在后台合成，完成后通过 tts:ready 推送给前端
    this._synthesizeInBackground(say, segue, scene, session);

    // 6. 记录历史
    const now = new Date();
    for (const song of songs) {
      this.state.addHistory({
        song_id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        cover: song.cover,
        duration: song.duration,
        scene,
        reason: scene !== 'manual' ? reason : null,
      });
    }

    // 7. 记录计划
    if (scene !== 'manual') {
      this.state.savePlan({
        plan_date: now.toISOString().slice(0, 10),
        plan_time: now.toTimeString().slice(0, 5),
        scene,
        status: 'done',
        say_text: say,
        song_ids: JSON.stringify(songs.map(s => s.id)),
        reason,
      });
    }

    return { songs, ttsUrl: null };
  }

  // 后台合成 TTS，完成后通过 WS 推送 tts:ready
  async _synthesizeInBackground(say, segue, scene, session) {
    try {
      const [ttsResult, segueTtsResult] = await Promise.all([
        this.tts.synthesize(say, scene),
        segue ? this.tts.synthesize(segue, scene).catch(() => null) : Promise.resolve(null),
      ]);

      if (ttsResult?.url) {
        session.ttsUrl = ttsResult.url;
        session.ttsText = ttsResult.text || say;
        session.ttsWords = ttsResult.words || [];
      }
      if (segueTtsResult?.url) {
        session.segueTtsUrl = segueTtsResult.url;
        session.segueTtsText = segueTtsResult.text || segue;
        session.segueTtsWords = segueTtsResult.words || [];
      }

      this.state.setCurrentSession(session);
      this._broadcast({ ttsUrl: session.ttsUrl, segueTtsUrl: session.segueTtsUrl }, 'tts:ready');
    } catch (err) {
      console.warn(`[Executor] TTS 后台合成失败: ${err.message}`);
    }
  }

  // ── 歌手名模糊匹配 ──
  _artistMatch(requested, candidate) {
    if (!requested || !candidate) return false;
    const r = requested.toLowerCase().replace(/\s+/g, '');
    const c = candidate.toLowerCase().replace(/\s+/g, '');
    if (r === c) return true;
    // 处理 "林忆莲" vs "林忆莲、李宗盛" 这种多歌手情况
    if (c.includes(r) || r.includes(c)) return true;
    // 处理英文艺名 vs 本名，如 "JJ Lin" vs "林俊杰"
    const rParts = r.split(/[,，/、&]/);
    const cParts = c.split(/[,，/、&]/);
    return rParts.some(rp => cParts.some(cp => cp.trim() === rp.trim()));
  }

  // ── 通过搜索匹配最合适的歌曲（不依赖 AI 提供的 ID） ──
  async _searchAndResolveSong(item) {
    const searchKeyword = `${item.title || ''} ${item.artist || ''}`.trim();
    if (!searchKeyword) return null;

    const results = await this.music.search(searchKeyword, 5);
    if (results.length === 0) return null;

    // 第一优先：歌手名精确匹配
    let match = results.find(r => this._artistMatch(item.artist, r.artist));
    // 第二优先：歌名包含匹配
    if (!match && item.title) {
      const t = item.title.toLowerCase();
      match = results.find(r => r.title.toLowerCase().includes(t) || t.includes(r.title.toLowerCase()));
    }
    // 第三优先：取第一个结果（至少是同一搜索关键词的结果）
    if (!match) match = results[0];

    // 如果匹配的歌手不一致，记录警告
    if (item.artist && !this._artistMatch(item.artist, match.artist)) {
      console.log(`[Executor] 歌手不匹配: 请求="${item.artist}" 结果="${match.artist}"，仍使用搜索结果`);
    }

    let url = this.state.getCachedUrl(match.id);
    if (!url) {
      url = await this.music.getSongUrl(match.id);
      if (url) this.state.setCachedUrl(match.id, url);
    }
    if (!url) return null;

    const detail = await this.music.getSongDetail(match.id).catch(() => ({
      id: match.id, title: match.title, artist: match.artist, cover: '', duration: 0,
    }));

    // 异步获取 MV 信息（不阻塞播放）
    let mvId = 0;
    try {
      mvId = await this.music.getSongMvId(match.id);
    } catch { /* 静默 */ }

    return {
      id: detail.id || match.id,
      title: detail.title || match.title,
      artist: detail.artist || match.artist,
      cover: detail.cover || match.cover || '',
      duration: detail.duration || 0,
      url,
      reason: item.reason || '',
      mvId: mvId || undefined,
    };
  }

  // ── Chat 歌曲解析（轻量版） ──
  async resolveChatSongs(songs) {
    const resolved = [];
    for (const item of (songs || []).slice(0, 3)) {
      try {
        // 直接搜索匹配，不依赖 AI 提供的 ID
        const song = await this._searchAndResolveSong(item);
        if (song) {
          resolved.push(song);
          console.log(`[Chat] 歌曲解析: "${item.title} - ${item.artist}" → "${song.title} - ${song.artist}"`);
        } else {
          console.warn(`[Chat] 未找到可播放版本: "${item.title} - ${item.artist}"`);
        }
      } catch (err) {
        console.warn(`[Chat] 跳过歌曲: ${err.message}`);
      }
    }
    return resolved;
  }

  // ── 播放控制快捷方法 ──

  togglePlay() {
    const session = this.state.getCurrentSession();
    if (!session) return null;
    session.isPlaying = !session.isPlaying;
    this._broadcast(session, 'state:update');
    return session;
  }

  nextSong() {
    const session = this.state.getCurrentSession();
    if (!session || session.songs.length === 0) return null;

    if (session.currentIndex >= session.songs.length - 1) {
      session.currentIndex = 0;
    } else {
      session.currentIndex++;
    }

    session.currentSong = session.songs[session.currentIndex];
    this.preloader?.onSongChange(session.currentIndex, session.songs);
    this._broadcast(session, 'song:change');
    return session;
  }

  prevSong() {
    const session = this.state.getCurrentSession();
    if (!session || session.songs.length === 0) return null;

    if (session.currentIndex <= 0) {
      session.currentIndex = session.songs.length - 1;
    } else {
      session.currentIndex--;
    }

    session.currentSong = session.songs[session.currentIndex];
    this._broadcast(session, 'song:change');
    return session;
  }

  setVolume(level) {
    const clamped = Math.max(0, Math.min(100, level));
    this.state.persistState('volume', clamped);
    this._broadcast({ volume: clamped }, 'state:update');
    return clamped;
  }

  switchDevice(deviceId) {
    this.state.setActiveDevice(deviceId);
    this._broadcast({ device: deviceId }, 'state:update');
  }

  _broadcast(data, event) {
    if (this.ws) {
      this.ws.broadcast(event, data);
    }
  }
}
