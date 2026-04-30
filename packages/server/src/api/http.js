import express, { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const TASTE_PATH = resolve('./data/taste.md');
const ROUTINES_PATH = resolve('./data/routines.md');

export function createHttpApi({ state, executor, scheduler, router: intentRouter, claude, contextBuilder, music, ws, tts }) {
  const api = Router();
  api.use(express.json());

  // ── 播放状态 ──
  api.get('/now', (req, res) => {
    const session = state.getCurrentSession();
    const volume = state.restoreState('volume') || 80;
    res.json({
      status: session?.isPlaying ? 'playing' : 'paused',
      ...(session ? {
        currentSong: session.currentSong || null,
        currentIndex: session.currentIndex,
        total: session.songs.length,
        sayText: session.sayText,
        segueText: session.segueText,
        scene: session.scene,
        startedAt: session.startedAt,
      } : {}),
      volume,
      device: state.getActiveDevice(),
    });
  });

  // ── 播放队列 ──
  api.get('/queue', (req, res) => {
    res.json({ queue: state.getQueue(), total: state.getQueue().length });
  });

  api.post('/queue', (req, res) => {
    const { song } = req.body;
    if (!song?.id) return res.status(400).json({ error: 'song.id required' });
    state.addToQueue(song);
    ws?.broadcast('queue:update', state.getQueue());
    res.json({ ok: true, queue: state.getQueue() });
  });

  api.delete('/queue', (req, res) => {
    state.clearQueue();
    ws?.broadcast('queue:update', []);
    res.json({ ok: true });
  });

  // ── Chat 对话 ──
  api.post('/chat', async (req, res) => {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    try {
      const currentSession = state.getCurrentSession();
      const recentHistory = state.getRecentSongs(2);

      const fragments = await contextBuilder.buildChat(messages, {
        device: state.getActiveDevice(),
        currentSong: currentSession?.currentSong || null,
        recentHistory,
      });

      const prompt = contextBuilder.toChatPrompt(fragments);
      const response = await claude.thinkChat(prompt);

      // 解析歌曲并做发现过滤
      let resolvedSongs = [];
      if (response.songs && response.songs.length > 0) {
        resolvedSongs = await executor.resolveChatSongs(response.songs);

        // 发现过滤：排除已播放过的歌曲
        const knownIds = state.getAllKnownSongIds();
        const knownEntries = state.getExistingSongEntries();
        resolvedSongs = resolvedSongs.filter(s => {
          if (knownIds.has(String(s.id))) return false;
          return !knownEntries.some(k =>
            k.title && s.title &&
            k.title.toLowerCase() === s.title.toLowerCase() &&
            k.artist && s.artist &&
            k.artist.toLowerCase() === s.artist.toLowerCase()
          );
        });
      }

      // 可选 TTS：优先用 tts_text，否则 reply 短文本也合成
      let ttsUrl = null;
      let ttsWords = [];
      const ttsText = response.tts_text || response.reply || '';
      if (tts && ttsText) {
        const ttsResult = await tts.synthesize(ttsText, 'chat', { cache: false }).catch(() => null);
        if (ttsResult) { ttsUrl = ttsResult.url; ttsWords = ttsResult.words || []; }
      }

      return res.json({
        reply: response.reply,
        songs: resolvedSongs,
        mood: response.mood || 'neutral',
        tts_url: ttsUrl,
        tts_text: ttsUrl ? ttsText : null,
        tts_words: ttsWords,
      });
    } catch (err) {
      console.error('[API] /chat error:', err.message);
      return res.json({
        reply: '抱歉，我走神了一下，能再说一遍吗？',
        songs: [],
        mood: 'neutral',
        tts_url: null,
      });
    }
  });

  // ── Chat 流式对话（SSE） ──
  api.post('/chat/stream', async (req, res) => {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const currentSession = state.getCurrentSession();
      const recentHistory = state.getRecentSongs(2);

      const fragments = await contextBuilder.buildChat(messages, {
        device: state.getActiveDevice(),
        currentSong: currentSession?.currentSong || null,
        recentHistory,
      });

      const prompt = contextBuilder.toChatPrompt(fragments);

      for await (const chunk of claude.thinkChatStream(prompt)) {
        if (chunk.type === 'error') {
          send({ type: 'error', message: chunk.message });
          break;
        }
        if (chunk.type === 'text') {
          send({ type: 'text', text: chunk.text });
        }
        if (chunk.type === 'done') {
          // Parse songs and filter
          let resolvedSongs = [];
          if (chunk.songs && chunk.songs.length > 0) {
            resolvedSongs = await executor.resolveChatSongs(chunk.songs);
            const knownIds = state.getAllKnownSongIds();
            const knownEntries = state.getExistingSongEntries();
            resolvedSongs = resolvedSongs.filter(s => {
              if (knownIds.has(String(s.id))) return false;
              return !knownEntries.some(k =>
                k.title && s.title &&
                k.title.toLowerCase() === s.title.toLowerCase() &&
                k.artist && s.artist &&
                k.artist.toLowerCase() === s.artist.toLowerCase()
              );
            });
          }

          let ttsUrl = null;
          let ttsWords = [];
          const ttsText = chunk.tts_text || chunk.reply || '';
          if (tts && ttsText) {
            const ttsResult = await tts.synthesize(ttsText, 'chat', { cache: false }).catch(() => null);
            if (ttsResult) { ttsUrl = ttsResult.url; ttsWords = ttsResult.words || []; }
          }

          send({
            type: 'done',
            reply: chunk.reply,
            songs: resolvedSongs,
            mood: chunk.mood || 'neutral',
            tts_url: ttsUrl,
            tts_text: ttsUrl ? ttsText : null,
            tts_words: ttsWords,
          });
        }
      }
    } catch (err) {
      console.error('[API] /chat/stream error:', err.message);
      send({ type: 'error', message: '抱歉，我走神了一下，能再说一遍吗？' });
    }

    res.end();
  });

  // ── 歌曲故事/冷知识（DJ 播放中主动讲述）──
  api.post('/song/story', async (req, res) => {
    const { title, artist } = req.body;
    if (!title || !artist) return res.status(400).json({ error: 'title and artist required' });

    try {
      const story = await claude.generateSongStory(title, artist);
      const response = { story: story || `正在播放 ${artist} 的《${title}》，好好享受音乐吧~` };

      if (tts && story) {
        const ttsResult = await tts.synthesize(story, 'discovery', { cache: false }).catch(() => null);
        if (ttsResult) {
          response.tts_url = ttsResult.url;
          response.tts_text = story;
          response.tts_words = ttsResult.words || [];
        }
      }

      res.json(response);
    } catch (err) {
      console.error('[API] /song/story error:', err.message);
      res.json({ story: '' });
    }
  });

  // ── 播放历史 ──
  api.get('/history', (req, res) => {
    const { limit = 50, offset = 0, scene } = req.query;
    res.json(state.getHistory({ limit: Number(limit), offset: Number(offset), scene }));
  });

  // ── 用户品味 ──
  api.get('/taste', (req, res) => {
    const taste = existsSync(TASTE_PATH) ? readFileSync(TASTE_PATH, 'utf-8') : '';
    const routines = existsSync(ROUTINES_PATH) ? readFileSync(ROUTINES_PATH, 'utf-8') : '';
    res.json({ taste, routines });
  });

  // ── 今日计划 ──
  api.get('/plan/today', (req, res) => {
    res.json(state.getTodaysPlans());
  });

  // ── 调度规则 ──
  api.get('/schedule', (req, res) => {
    res.json(state.getEnabledRules());
  });

  api.put('/schedule/:id', (req, res) => {
    const { enabled } = req.body;
    state.updateRule(Number(req.params.id), { enabled: enabled ? 1 : 0 });
    scheduler.reload();
    res.json({ ok: true });
  });

  // ── 命令入口 ──
  api.post('/command', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    // 调试：检查实际接收到的文本
    if (text.length <= 10) console.log(`[API] 命令原始: "${text}" hex=${Buffer.from(text).toString('hex')} chars=[${[...text].map(c => c.charCodeAt(0)).join(',')}]`);

    const route = intentRouter.route(text);

    // 直连命令
    switch (route.intent) {
      case 'toggle_play': {
        const result = executor.togglePlay();
        return res.json({ ok: true, intent: route.intent, payload: result });
      }
      case 'next_song': {
        const result = executor.nextSong();
        return res.json({ ok: true, intent: route.intent, payload: result });
      }
      case 'prev_song': {
        const result = executor.prevSong();
        return res.json({ ok: true, intent: route.intent, payload: result });
      }
      case 'volume_set': {
        executor.setVolume(route.payload);
        return res.json({ ok: true, intent: route.intent, volume: route.payload });
      }
      case 'volume_up': {
        const current = state.restoreState('volume') || 80;
        executor.setVolume(current + 10);
        return res.json({ ok: true, intent: route.intent });
      }
      case 'volume_down': {
        const current = state.restoreState('volume') || 80;
        executor.setVolume(current - 10);
        return res.json({ ok: true, intent: route.intent });
      }
      case 'mute': {
        executor.setVolume(0);
        return res.json({ ok: true, intent: route.intent });
      }
      case 'switch_device': {
        executor.switchDevice(route.payload);
        return res.json({ ok: true, intent: route.intent, device: route.payload });
      }
      case 'list_devices': {
        return res.json({ ok: true, devices: state.getAvailableDevices() });
      }
      case 'now_playing': {
        const session = state.getCurrentSession();
        return res.json({ ok: true, current: session?.currentSong || null });
      }
      case 'today_plan': {
        return res.json({ ok: true, plans: state.getTodaysPlans() });
      }
      case 'current_song_info': {
        const session = state.getCurrentSession();
        return res.json({ ok: true, song: session?.currentSong || null });
      }
    }

    // Claude 处理
    if (route.intent === 'claude') {
      try {
        const trigger = { ...route, device: state.getActiveDevice() };
        const fragments = await contextBuilder.build(trigger, null, null);
        const prompt = contextBuilder.toPrompt(fragments);
        const response = await claude.think(prompt);
        const result = await executor.execute(response, 'manual');
        return res.json({ ok: true, intent: 'claude', result });
      } catch (err) {
        console.error('[API] Claude 处理失败:', err);
        return res.status(500).json({ ok: false, error: err.message });
      }
    }

    return res.status(400).json({ ok: false, error: `unknown intent: ${route.intent}` });
  });

  // ── 手动触发场景 ──
  api.post('/trigger', async (req, res) => {
    const { scene } = req.body;
    if (!scene) return res.status(400).json({ error: 'scene required' });
    try {
      await scheduler.triggerScene(scene);
      res.json({ ok: true, scene });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── 设备管理 ──
  api.get('/devices', (req, res) => {
    res.json({ devices: state.getAvailableDevices(), active: state.getActiveDevice() });
  });

  api.post('/devices/switch', (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    executor.switchDevice(deviceId);
    res.json({ ok: true, device: deviceId });
  });

  // ── 搜索歌曲 ──
  api.get('/search', async (req, res) => {
    const { q, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    try {
      const results = await music.search(q, Number(limit));
      res.json({ results });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── 调试：测试路由 ──
  api.get('/debug/route', (req, res) => {
    const { text = '' } = req.query;
    res.json(intentRouter.route(text));
  });

  // ── 个性化推荐 ──
  api.get('/recommendations', async (req, res) => {
    try {
      const [status, recommendPlaylists] = await Promise.all([
        music.getLoginStatus().catch(() => ({ data: null })),
        music.getRecommendPlaylists(6).catch(() => []),
      ]);

      const profile = status?.data?.profile;
      if (!profile) {
        return res.json({ loggedIn: false, recommendPlaylists });
      }

      const uid = profile.userId;
      const userPlaylists = await music.getUserPlaylists(uid, 20).catch(() => []);
      const likedIds = await music.getLikedSongs(uid).catch(() => []);
      const records = await music.getUserRecords(uid, 1).catch(() => []);

      res.json({
        loggedIn: true,
        profile: {
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl || '',
          userId: profile.userId,
        },
        userPlaylists: (Array.isArray(userPlaylists) ? userPlaylists : []).slice(0, 10).map(p => ({
          id: String(p.id),
          name: p.name,
          cover: p.coverImgUrl || p.picUrl || '',
          trackCount: p.trackCount,
        })),
        likedCount: Array.isArray(likedIds) ? likedIds.length : 0,
        topSongs: (Array.isArray(records) ? records : []).slice(0, 10).map(r => ({
          title: r.song?.name || '',
          artist: r.song?.ar?.map(a => a.name).join(', ') || '',
          score: r.score,
        })),
        recommendPlaylists,
      });
    } catch (err) {
      console.error('[API] /recommendations error:', err.message);
      res.json({ loggedIn: false, recommendPlaylists: [], error: err.message });
    }
  });

  // ── 单曲 URL 解析 ──
  api.get('/song/url', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const url = await music.getSongUrl(id);
      res.json({ id, url });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── 歌词 ──
  api.get('/lyrics', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
      const lyric = await music.getLyric(id);
      res.json(lyric);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── 歌单歌曲 ──
  api.get('/playlist/:id/tracks', async (req, res) => {
    try {
      const tracks = await music.getPlaylistTracks(req.params.id, 30);
      // Resolve URLs for each track
      const withUrls = await Promise.all(tracks.slice(0, 10).map(async (t) => {
        const url = await music.getSongUrl(t.id).catch(() => null);
        return { ...t, url };
      }));
      res.json({ tracks: withUrls });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── MV 查询（根据歌曲 ID 获取 MV 信息和播放地址）──
  api.get('/mv/:songId', async (req, res) => {
    const { songId } = req.params;
    try {
      const mvId = await music.getSongMvId(songId);
      if (!mvId) return res.json({ hasMv: false });

      const [detail, url] = await Promise.all([
        music.getMvDetail(mvId),
        music.getMvUrl(mvId, 720),
      ]);

      res.json({
        hasMv: true,
        mvId: String(mvId),
        detail,
        url,  // 直链（有时效），前端播放时通过代理
      });
    } catch (err) {
      console.error('[API] /mv error:', err.message);
      res.json({ hasMv: false });
    }
  });

  // ── MV 视频代理（绕过防盗链）──
  api.get('/mv/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });

    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { Referer: 'https://music.163.com' },
      });
      if (!response.ok) return res.status(502).json({ error: `upstream ${response.status}` });

      const contentType = response.headers.get('content-type') || 'video/mp4';
      const contentLength = response.headers.get('content-length');
      res.set('Content-Type', contentType);
      if (contentLength) res.set('Content-Length', contentLength);
      res.set('Accept-Ranges', 'bytes');
      res.set('Cache-Control', 'public, max-age=3600');

      const { Readable } = await import('stream');
      const body = Readable.fromWeb(response.body);
      body.pipe(res);
    } catch (err) {
      console.error('[API] /mv/proxy error:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ── 音频代理（绕过网易云 CDN CORS 限制）──
  api.get('/audio/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });

    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) return res.status(502).json({ error: `upstream ${response.status}` });

      const contentType = response.headers.get('content-type') || 'audio/mpeg';
      const contentLength = response.headers.get('content-length');
      res.set('Content-Type', contentType);
      if (contentLength) res.set('Content-Length', contentLength);
      res.set('Accept-Ranges', 'bytes');

      // Node fetch body -> Node readable stream -> pipe to response
      const { Readable } = await import('stream');
      const body = Readable.fromWeb(response.body);
      body.pipe(res);
    } catch (err) {
      console.error('[API] /audio/proxy error:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ── 健康检查 ──
  api.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      wsConnections: ws?.connectionCount || 0,
      queueLength: state.getQueue().length,
      memory: process.memoryUsage().rss,
    });
  });

  return api;
}
