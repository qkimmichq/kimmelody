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

    // 1. 解析播放队列，逐首获取直链
    const songs = [];
    for (const item of play) {
      try {
        // 先查缓存
        let url = this.state.getCachedUrl(item.id);
        let resolvedId = item.id;

        if (!url) {
          url = await this.music.getSongUrl(resolvedId);
          if (url) this.state.setCachedUrl(resolvedId, url);
        }

        // URL 不可用 → 尝试搜索歌名+歌手作为后备
        if (!url && item.title) {
          const keywords = `${item.title} ${item.artist || ''}`.trim();
          const results = await this.music.search(keywords, 3);
          const found = results[0]; // 取第一个搜索结果
          if (found) {
            resolvedId = found.id;
            url = await this.music.getSongUrl(resolvedId);
            if (url) {
              this.state.setCachedUrl(resolvedId, url);
              console.log(`[Executor] 后备搜索命中: ${found.title} - ${found.artist}`);
            }
          }
        }

        if (!url) {
          console.warn(`[Executor] 跳过无播放地址的歌曲: ${item.title || item.id}`);
          continue;
        }

        let detail = null;
        try {
          detail = await this.music.getSongDetail(resolvedId);
        } catch {
          detail = { id: resolvedId, title: item.title, artist: item.artist, album: '', cover: '', duration: 0 };
        }

        let lyric = null;
        try {
          const cached = this.state.getCachedLyric(resolvedId);
          lyric = cached || await this.music.getLyric(resolvedId);
          if (!cached && lyric) this.state.setCachedLyric(resolvedId, lyric);
        } catch {
          lyric = { lrc: '', tlrc: '' };
        }

        songs.push({
          id: detail.id,
          title: detail.title || item.title || '未知歌曲',
          artist: detail.artist || item.artist || '未知歌手',
          album: detail.album || '',
          cover: detail.cover || '',
          duration: detail.duration || 0,
          url,
          lyric,
        });
      } catch (err) {
        console.warn(`[Executor] 跳过歌曲 ${item.id || item.title}: ${err.message}`);
      }
    }

    if (songs.length === 0) {
      console.warn('[Executor] 所有歌曲获取失败');
      // 即使无歌曲也返回播报，告知用户
      return { songs: [], ttsUrl: null, say: say || '暂时没有找到可以播放的音乐，稍后再试试吧' };
    }

    // 2. TTS 合成播报
    let ttsResult = null;
    try {
      ttsResult = await this.tts.synthesize(say, scene);
    } catch (err) {
      console.warn(`[Executor] TTS 失败: ${err.message}`);
    }

    // 3. 设置当前会话
    const session = {
      songs,
      currentIndex: 0,
      currentSong: songs[0],
      ttsUrl: ttsResult?.url || null,
      sayText: say,
      segueText: segue,
      scene,
      startedAt: Date.now(),
      isPlaying: true,
    };
    this.state.setCurrentSession(session);
    this.state.setQueue(songs);

    // 4. 触发预加载
    this.preloader?.onSongChange(0, songs);

    // 5. WS 推送
    this._broadcast(session, 'song:change');

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

    return { songs, ttsUrl: ttsResult?.url || null };
  }

  // ── Chat 歌曲解析（轻量版） ──
  async resolveChatSongs(songs) {
    const resolved = [];
    for (const item of (songs || []).slice(0, 3)) {
      try {
        let url = this.state.getCachedUrl(item.id);
        if (!url) {
          url = await this.music.getSongUrl(item.id);
          if (url) this.state.setCachedUrl(item.id, url);
        }
        if (!url && item.title) {
          const results = await this.music.search(`${item.title} ${item.artist || ''}`, 3);
          if (results[0]) {
            url = await this.music.getSongUrl(results[0].id);
            if (url) this.state.setCachedUrl(results[0].id, url);
          }
        }
        if (!url) continue;

        const detail = await this.music.getSongDetail(item.id).catch(() => ({
          id: item.id, title: item.title, artist: item.artist, cover: '', duration: 0,
        }));

        resolved.push({
          id: detail.id,
          title: detail.title || item.title,
          artist: detail.artist || item.artist,
          cover: detail.cover || '',
          duration: detail.duration || 0,
          url,
          reason: item.reason || '',
        });
      } catch (err) {
        console.warn(`[Chat] 跳过歌曲 ${item.id}: ${err.message}`);
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
