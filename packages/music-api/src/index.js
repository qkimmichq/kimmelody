// NeteaseCloudMusicApi 封装
// 需要先启动 NeteaseCloudMusicApi 服务（推荐 docker 或 npx 运行）

const DEFAULT_BASE = 'http://localhost:3000';

export class NeteaseMusic {
  constructor(baseUrl = process.env.NETEASE_API_BASE || DEFAULT_BASE) {
    this.base = baseUrl;
    this._cookie = null;
  }

  // 匿名登录（获取更完整的歌曲数据）
  async login() {
    try {
      const data = await this._fetch('/register/anonimous');
      if (data.cookie) {
        this._cookie = data.cookie;
        // 从 cookie 提取 MUSIC_U
        const musicU = data.cookie.split(';').find(c => c.trim().startsWith('MUSIC_U='));
        if (musicU) console.log('[Netease] 匿名登录成功');
      }
    } catch (err) {
      console.warn('[Netease] 匿名登录失败（不影响搜索）:', err.message);
    }
  }

  async _fetch(endpoint, params = {}) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${this.base}${endpoint}${qs ? '?' + qs : ''}`;

    const opts = {};
    if (this._cookie) opts.headers = { Cookie: this._cookie };

    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`Netease API ${res.status}: ${res.statusText}`);
    return res.json();
  }

  // 搜索歌曲
  async search(keyword, limit = 10) {
    const data = await this._fetch('/search', { keywords: keyword, limit });
    if (!data.result?.songs) return [];
    return data.result.songs.map(s => ({
      id: String(s.id),
      title: s.name,
      artist: s.artists.map(a => a.name).join(', '),
      album: s.album?.name || '',
      cover: s.album?.picUrl || '',
      duration: s.duration ? Math.round(s.duration / 1000) : 0,
    }));
  }

  // 获取歌曲 URL（直链，有时效）
  async getSongUrl(songId, level = 'standard') {
    try {
      const data = await this._fetch('/song/url/v1', { id: songId, level });
      return data.data?.[0]?.url || null;
    } catch (err) {
      console.warn(`[Netease] getSongUrl(${songId}) 失败: ${err.message}`);
      return null;
    }
  }

  // 获取歌词
  async getLyric(songId) {
    const data = await this._fetch('/lyric', { id: songId });
    return {
      lrc: data.lrc?.lyric || '',
      tlrc: data.tlyric?.lyric || '',
    };
  }

  // 获取歌曲详情
  async getSongDetail(songId) {
    const data = await this._fetch('/song/detail', { ids: songId });
    const s = data.songs?.[0];
    if (!s) return null;
    return {
      id: String(s.id),
      title: s.name,
      artist: s.ar.map(a => a.name).join(', '),
      album: s.al?.name || '',
      cover: s.al?.picUrl || '',
      duration: s.dt ? Math.round(s.dt / 1000) : 0,
    };
  }

  // 获取推荐歌单（发现页）
  async getRecommendPlaylists(limit = 6) {
    const data = await this._fetch('/personalized', { limit });
    if (!data.result) return [];
    return data.result.map(p => ({
      id: String(p.id),
      name: p.name,
      cover: p.picUrl,
      trackCount: p.trackCount,
    }));
  }

  // 获取歌单详情（歌曲列表）
  async getPlaylistTracks(playlistId, limit = 30) {
    const data = await this._fetch('/playlist/track/all', { id: playlistId, limit });
    if (!data.songs) return [];
    return data.songs.map(s => ({
      id: String(s.id),
      title: s.name,
      artist: s.ar.map(a => a.name).join(', '),
      album: s.al?.name || '',
      cover: s.al?.picUrl || '',
      duration: s.dt ? Math.round(s.dt / 1000) : 0,
    }));
  }

  // 获取歌曲的音频特征（用于情绪分析）
  async getAudioFeatures(songId) {
    const data = await this._fetch('/song/detail', { ids: songId });
    return data.songs?.[0] || null;
  }

  // ════════════════════════════════════════
  //  登录与用户数据（用于个性化推荐）
  // ════════════════════════════════════════

  // 从文件加载 cookie
  async loadCookie(cookiePath) {
    try {
      const { readFileSync, existsSync } = await import('fs');
      if (!existsSync(cookiePath)) {
        console.log(`[Netease] Cookie 文件不存在: ${cookiePath}`);
        return false;
      }
      this._cookie = readFileSync(cookiePath, 'utf-8').trim();
      if (!this._cookie) {
        console.log('[Netease] Cookie 文件为空');
        return false;
      }
      // Cookie 可能是单独的 MUSIC_U=... 或完整的 cookie 字符串
      const hasMusicU = this._cookie.includes('MUSIC_U=');
      if (hasMusicU) {
        console.log('[Netease] ✅ 已加载用户登录凭证');
        // 如果是单独一行 MUSIC_U=xxx，确保 _fetch 能正确发送
        if (!this._cookie.includes(';') && this._cookie.startsWith('MUSIC_U=')) {
          this._cookie = this._cookie; // 直接作为 Cookie header 值
        }
        return true;
      }
      console.log('[Netease] Cookie 缺少 MUSIC_U 字段');
      return false;
    } catch (err) {
      console.warn(`[Netease] 加载 cookie 失败: ${err.message}`);
      return false;
    }
  }

  // 获取登录状态
  async getLoginStatus() {
    return this._fetch('/login/status');
  }

  // 获取用户歌单列表
  async getUserPlaylists(uid, limit = 30) {
    const data = await this._fetch('/user/playlist', { uid, limit });
    return data.playlist || [];
  }

  // 获取听歌排行
  async getUserRecords(uid, type = 1) {
    const data = await this._fetch('/user/record', { uid, type });
    return data.allData || [];
  }

  // 获取喜欢列表
  async getLikedSongs(uid) {
    const data = await this._fetch('/likelist', { uid });
    return data.ids || [];
  }

  // ════════════════════════════════════════
  //  MV 相关
  // ════════════════════════════════════════

  // 从歌曲详情中提取 MV ID（0 表示无 MV）
  async getSongMvId(songId) {
    try {
      const data = await this._fetch('/song/detail', { ids: songId });
      return data.songs?.[0]?.mv || 0;
    } catch {
      return 0;
    }
  }

  // 获取 MV 详情
  async getMvDetail(mvId) {
    try {
      const data = await this._fetch('/mv/detail', { mvid: mvId });
      if (!data.data) return null;
      const d = data.data;
      return {
        id: String(d.id),
        name: d.name,
        artistName: d.artistName,
        cover: d.cover || d.coverUrl || '',
        duration: d.duration || 0,
        resolutions: (d.brs || []).map(b => b.br),
        playCount: d.playCount || 0,
      };
    } catch {
      return null;
    }
  }

  // 获取 MV 播放地址
  async getMvUrl(mvId, resolution = 720) {
    try {
      const data = await this._fetch('/mv/url', { id: mvId, r: resolution });
      return data.data?.url || null;
    } catch {
      return null;
    }
  }
}
