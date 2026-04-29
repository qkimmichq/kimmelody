// ── Kimmelody Frontend ──

const API_BASE = window.location.origin;
const WS_URL = `${window.location.origin.replace(/^http/, 'ws')}`;

class KimmelodyApp {
  constructor() {
    this.audio = document.querySelector('#audioPlayer') || new Audio();
    this.ws = null;
    this.state = {
      isPlaying: false,
      currentSong: null,
      queue: [],
      volume: 80,
      device: 'local',
      songs: [],
      currentIndex: 0,
      scene: null,
      sayText: null,
      segueText: null,
      plans: [],
      rules: [],
    };
    this.lyricLines = [];
    this._currentLyricIndex = -1;
    this._nextAudio = null;
    this._preloadedNextIndex = -1;
    this.broadcastTimer = null;
    this.progressInterval = null;
    this.reconnectAttempts = 0;
    this.state.chatHistory = [];
    this.state.chatSending = false;
    this.state.lastMood = 'neutral';
    this._audioCtx = null;
    this._analyser = null;
    this._audioSource = null;
    this._audioDataArray = null;
    this._animFrameId = null;
    this._audioCtxReady = false;
    this._audioInitAttempted = false;
    this._typingEl = null;

    // MV 状态
    this._mvActive = false;
    this._mvInfo = null;       // { mvId, detail, songId }
    this._mvChecking = false;
    this._mvWasPlaying = undefined;

    this._cacheDOM();
    this._bindEvents();
    this._connectWS();
    this._fetchInitialState();
    this._hideSplash();
    this._showWelcomeMessage();
  }

  _cacheDOM() {
    this.$ = (sel) => document.querySelector(sel);
    this.$$ = (sel) => document.querySelectorAll(sel);

    this.splash = this.$('#splash');

    // Radio / Chat view
    this.radioView = this.$('#viewRadio');
    this.radioAlbumThumb = this.$('#radioAlbumThumb');
    this.radioAlbumImg = this.$('#radioAlbumImg');
    this.radioSongTitle = this.$('#radioSongTitle');
    this.radioSongArtist = this.$('#radioSongArtist');
    this.radioPlayBtn = this.$('#radioPlayBtn');
    this.radioPlayIcon = this.$('#radioPlayIcon');
    this.radioNextBtn = this.$('#radioNextBtn');
    this.waveCanvas = this.$('#waveCanvas');
    this.chatMessages = this.$('#chatMessages');
    this.chatInput = this.$('#chatInput');
    this.chatSendBtn = this.$('#chatSendBtn');

    // 右侧播放栏
    this.songTitle = this.$('#songTitle');
    this.songArtist = this.$('#songArtist');
    this.albumArt = this.$('#albumArt');
    this.recordDisc = this.$('#recordDisc');
    this.albumContainer = this.$('.album-container');
    this.broadcastBubble = this.$('#broadcastBubble');
    this.broadcastText = this.$('#broadcastText');
    this.lyricsView = this.$('#lyricsView');
    this.playIcon = this.$('#playIcon');
    this.playBtn = this.$('#playBtn');
    this.nextBtn = this.$('#nextBtn');
    this.prevBtn = this.$('#prevBtn');
    this.radioPlayerCol = this.$('.radio-player-col');

    // MV 相关
    this.mvBadge = this.$('#mvBadge');
    this.mvVideo = this.$('#mvVideo');
    this.mvLoading = this.$('#mvLoading');
    this.mvControls = this.$('#mvControls');
    this.mvCloseBtn = this.$('#mvCloseBtn');
    this.mvFullscreenBtn = this.$('#mvFullscreenBtn');
    this.albumContainerEl = this.$('#albumContainer');

    // 推荐
    this.recommendContent = this.$('#recommendContent');
    this.closePlayerBtn = this.$('#closePlayerBtn');

    // Progress (shared across views)
    this.progressBar = this.$('#progressBar');
    this.timeCurrent = this.$('#timeCurrent');
    this.timeTotal = this.$('#timeTotal');

    // Settings
    this.volumeSlider = this.$('#volumeSlider');
    this.volumeLabel = this.$('#volumeLabel');
    this.deviceLabel = this.$('#deviceLabel');
    this.scheduleList = this.$('#scheduleList');
    this.connectionStatus = this.$('#connectionStatus');
    this.showTasteBtn = this.$('#showTasteBtn');

    // Search
    this.searchOverlay = this.$('#searchOverlay');
    this.searchInput = this.$('#searchInput');
    this.searchResults = this.$('#searchResults');
    this.searchBtn = this.$('#searchBtn');
    this.closeSearchBtn = this.$('#closeSearchBtn');

    // Volume quick
    this.volumeQuickSlider = this.$('#volumeQuick');
    this.volumeQuickLabel = this.$('#volumeQuickLabel');

    // Queue / Timeline
    this.queueList = this.$('#queueList');
    this.timelineList = this.$('#timelineList');

    // Navigation
    this.navItems = this.$$('.nav-item');
    this.views = {
      radio: this.$('#viewRadio'),
      recommend: this.$('#viewRecommend'),
      queue: this.$('#viewQueue'),
      timeline: this.$('#viewTimeline'),
      settings: this.$('#viewSettings'),
    };
  }

  _bindEvents() {
    // 导航
    this.navItems.forEach(item => {
      item.addEventListener('click', () => this._switchView(item.dataset.view));
    });

    // Radio 播放控制
    this.radioPlayBtn?.addEventListener('click', () => this._togglePlay());
    this.radioNextBtn?.addEventListener('click', () => this._sendCommand('下一首'));

    // 右侧播放栏控制
    this.playBtn?.addEventListener('click', () => this._togglePlay());
    this.nextBtn?.addEventListener('click', () => this._sendCommand('下一首'));
    this.prevBtn?.addEventListener('click', () => this._sendCommand('上一首'));

    // 移动端：点击封面展开播放栏
    this.radioAlbumThumb?.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      this._toggleMobilePlayer();
    });
    this.closePlayerBtn?.addEventListener('click', () => this._toggleMobilePlayer());

    // 进度条
    this.progressBar?.addEventListener('input', (e) => {
      if (this.audio.duration) {
        this.audio.currentTime = (e.target.value / 100) * this.audio.duration;
      }
    });

    // 音量（设置页）
    this.volumeSlider.addEventListener('input', (e) => this._setVolume(e.target.value));

    // 快捷音量
    this.volumeQuickSlider?.addEventListener('input', (e) => this._setVolume(e.target.value));

    // 搜索
    this.searchBtn?.addEventListener('click', () => this._toggleSearch(true));
    this.closeSearchBtn?.addEventListener('click', () => this._toggleSearch(false));
    this.searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._doSearch(this.searchInput.value);
      if (e.key === 'Escape') this._toggleSearch(false);
    });
    this.searchInput?.addEventListener('input', () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        if (this.searchInput.value.trim().length >= 2) this._doSearch(this.searchInput.value);
      }, 400);
    });

    // Chat 输入
    this.chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendChatMessage();
      }
    });
    this.chatInput?.addEventListener('input', () => {
      if (this.chatSendBtn) {
        this.chatSendBtn.disabled = !this.chatInput.value.trim();
      }
    });
    this.chatSendBtn?.addEventListener('click', () => this._sendChatMessage());

    // Wave canvas click toggle
    this.waveCanvas?.addEventListener('click', () => this._togglePlay());

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); this._togglePlay(); }
      if (e.code === 'ArrowRight') this._sendCommand('下一首');
      if (e.code === 'ArrowLeft') this._sendCommand('上一首');
      if (e.code === 'ArrowUp') {
        this._setVolume(Math.min(100, parseInt(this.volumeSlider.value) + 5));
      }
      if (e.code === 'ArrowDown') {
        this._setVolume(Math.max(0, parseInt(this.volumeSlider.value) - 5));
      }
      if (e.code === 'Escape') {
        this.radioPlayerCol?.classList.remove('open');
      }
    });

    // Audio 事件
    this.audio.addEventListener('timeupdate', () => this._onTimeUpdate());
    this.audio.addEventListener('ended', () => this._onSongEnd());
    this.audio.addEventListener('loadedmetadata', () => {
      this.timeTotal.textContent = this._formatTime(this.audio.duration);
    });
    this.audio.addEventListener('error', (e) => {
      console.warn('[Audio] 解码错误:', this.audio.error?.message || 'unknown');
      this.state.isPlaying = false;
      this._updatePlayBtn();
    });

    // 显示口味配置
    this.showTasteBtn?.addEventListener('click', () => {
      this._api('GET', '/api/taste').then(data => {
        if (data.taste) {
          this._toast('品味配置已加载（查看 data/taste.md）');
        }
      });
    });

    // MV 按钮
    this.mvBadge?.addEventListener('click', (e) => { e.stopPropagation(); this._enterMv(); });
    this.mvCloseBtn?.addEventListener('click', () => this._closeMv());
    this.mvFullscreenBtn?.addEventListener('click', () => this._toggleMvFullscreen());
    this.mvVideo?.addEventListener('error', () => {
      this._toast('MV 加载失败');
      this._closeMv();
    });
    this.mvVideo?.addEventListener('loadeddata', () => {
      if (this.mvLoading) this.mvLoading.style.display = 'none';
    });
    this.mvVideo?.addEventListener('ended', () => this._closeMv());
  }

  // ── WebSocket ──
  _connectWS() {
    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        console.log('[WS] 已连接');
        this.connectionStatus.textContent = '已连接';
        this.connectionStatus.style.color = 'var(--green)';
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const { event: type, payload } = JSON.parse(event.data);
          this._handleWSEvent(type, payload);
        } catch {}
      };

      this.ws.onclose = () => {
        console.log('[WS] 断开');
        this.connectionStatus.textContent = '重连中...';
        this.connectionStatus.style.color = 'var(--red)';
        this._reconnectWS();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this._reconnectWS();
    }
  }

  _reconnectWS() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    setTimeout(() => this._connectWS(), delay);
  }

  _handleWSEvent(type, payload) {
    switch (type) {
      case 'song:change':
        this._updateNowPlaying(payload);
        break;
      case 'state:update':
        if (payload.isPlaying !== undefined) this._updatePlayState(payload);
        if (payload.volume !== undefined) {
          this.volumeSlider.value = payload.volume;
          this.volumeLabel.textContent = `${payload.volume}%`;
          this.volumeQuickSlider.value = payload.volume;
          this.volumeQuickLabel.textContent = `${payload.volume}%`;
          this.audio.volume = payload.volume / 100;
        }
        if (payload.device) {
          this.deviceLabel.textContent = payload.device;
        }
        break;
      case 'queue:update':
        this.state.queue = payload || [];
        this._renderQueue();
        break;
      case 'connected':
        console.log('[WS]', payload?.message);
        break;
    }
  }

  // ── API ──
  async _api(method, path, body) {
    try {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`${API_BASE}${path}`, opts);
      return await res.json();
    } catch (err) {
      console.error(`[API] ${method} ${path}:`, err);
      return null;
    }
  }

  async _fetchInitialState() {
    const now = await this._api('GET', '/api/now');
    if (now) {
      if (now.status === 'playing' || now.status === 'paused') {
        this.state.isPlaying = now.status === 'playing';
        this.state.volume = now.volume || 80;
        this.state.device = now.device || 'local';
        this.volumeSlider.value = this.state.volume;
        this.volumeLabel.textContent = `${this.state.volume}%`;
        this.volumeQuickSlider.value = this.state.volume;
        this.volumeQuickLabel.textContent = `${this.state.volume}%`;
        this.audio.volume = this.state.volume / 100;
        this.deviceLabel.textContent = this.state.device;
        if (now.currentSong) {
          this._updateNowPlayingUI(now);
        }
      }
    }

    // 加载队列
    const queue = await this._api('GET', '/api/queue');
    if (queue?.queue) {
      this.state.queue = queue.queue;
      this._renderQueue();
    }

    // 加载今日计划
    const plans = await this._api('GET', '/api/plan/today');
    if (plans) {
      this.state.plans = plans;
      this._renderTimeline();
    }

    // 加载调度规则
    const rules = await this._api('GET', '/api/schedule');
    if (rules) {
      this.state.rules = rules;
      this._renderSchedule();
    }
  }

  // ── 核心：统一播放入口 ──
  async _playSong(song, playlist = null, index = 0) {
    if (!song) return false;

    // Resolve URL if missing
    if (!song.url && song.id) {
      const data = await this._api('GET', `/api/song/url?id=${song.id}`);
      if (data?.url) song.url = data.url;
    }
    // Fallback: search by title+artist
    if (!song.url && song.title) {
      const q = `${song.title} ${song.artist || ''}`.trim();
      const data = await this._api('GET', `/api/search?q=${encodeURIComponent(q)}&limit=1`);
      if (data?.results?.[0]) {
        const urlData = await this._api('GET', `/api/song/url?id=${data.results[0].id}`);
        if (urlData?.url) {
          song = { ...song, ...data.results[0], url: urlData.url };
        }
      }
    }

    if (!song.url) {
      this._toast('该歌曲暂时无法播放');
      return false;
    }

    this.state.currentSong = song;
    if (playlist && playlist.length > 0) {
      this.state.songs = playlist;
      this.state.currentIndex = index;
    } else {
      this.state.songs = [song];
      this.state.currentIndex = 0;
    }

    // 通过服务器代理音频，避免网易云 CDN 跨域导致 AudioContext 输出静音
    this.audio.src = `/api/audio/proxy?url=${encodeURIComponent(song.url)}`;
    this.audio.load();

    if (!this._audioCtx) this._initAudioAnalyser();
    await this._resumeAudioContext();
    try {
      await this.audio.play();
      this.state.isPlaying = true;
    } catch (err) {
      this.state.isPlaying = false;
      console.warn('[Audio] play() rejected:', err.message);
      this._toast('播放被浏览器阻止，请再次点击播放');
    }

    this._syncPlayingUI();
    this._updateNowPlayingUI(this.state);
    this._renderQueue();
    this._fetchAndShowLyrics(song);
    this._preloadNextSong();

    // 启动 DJ 故事计时器：播放 25 秒后自动讲述歌曲趣事
    this._scheduleSongStory(song);
    // 异步检测 MV 可用性
    this._checkMvAvailability(song);
    return true;
  }

  _syncPlayingUI() {
    this._updatePlayBtn();
    if (this.recordDisc) {
      this.recordDisc.classList.toggle('playing', this.state.isPlaying);
      this.recordDisc.classList.add('visible');
    }
    if (this.albumContainer) {
      this.albumContainer.classList.toggle('playing', this.state.isPlaying);
    }
  }

  async _resolveAndPlaySong(song) {
    this._toast('正在加载歌曲...');
    await this._playSong(song);
  }

  // ── 播放控制 ──
  async _togglePlay() {
    // Prime audio element with user activation BEFORE any await.
    // Without this, play() called from WebSocket callbacks (non-user-gesture)
    // will be blocked by browser autoplay policy.
    this._primeAudio();

    // Pause
    if (this.state.isPlaying) {
      this.audio.pause();
      this.state.isPlaying = false;
      this._syncPlayingUI();
      this._sendCommand('暂停');
      return;
    }

    // Resume existing session
    if (this.audio.src || this.state.currentSong?.url) {
      if (!this._audioCtx) this._initAudioAnalyser();
      await this._resumeAudioContext();
      try {
        await this.audio.play();
        this.state.isPlaying = true;
        this._syncPlayingUI();
      } catch (err) {
        console.warn('[Audio] resume failed:', err);
        this._toast('播放失败，请重试');
      }
      this._sendCommand('播放');
      return;
    }

    // No session — start radio
    this._startRadio();
  }

  _primeAudio() {
    // Only prime when audio element has no real source loaded.
    // If a song is already loaded, play/pause/rewind would destroy
    // the current playback position (currentTime → 0).
    if (!this.audio) return;
    if (this.audio.src) return;

    this.audio.src = 'data:audio/wav;base64,UklGRnoAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVoAAABBTF9TRUNUSU9OTEVOR1RIDQAAADIy';
    this.audio.play().then(() => {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.removeAttribute('src');
    }).catch(() => {
      this.audio.removeAttribute('src');
    });
  }

  _startRadio() {
    if (this._starting) return;
    this._starting = true;
    this._toast('AI 电台正在准备节目...');
    this._api('POST', '/api/trigger', { scene: 'mood_check' }).then(data => {
      this._starting = false;
      if (!data?.ok) this._toast('启动失败，请稍后再试');
    }).catch(() => {
      this._starting = false;
      this._toast('启动失败');
    });
  }

  async _updateNowPlaying(payload) {
    if (!payload?.songs?.length) return;

    // Dedup: skip if the same song is already playing
    const song = payload.currentSong || payload.songs[0];
    if (this.state.currentSong?.id && song?.id
        && String(this.state.currentSong.id) === String(song.id)
        && this.state.isPlaying) {
      return;
    }

    this.state.songs = payload.songs;
    this.state.currentIndex = payload.currentIndex || 0;
    this.state.scene = payload.scene;
    this.state.sayText = payload.sayText;
    this.state.segueText = payload.segueText;

    await this._playSong(song, payload.songs, this.state.currentIndex);

    // Show broadcast if any (dedup by last text)
    if (payload.sayText) {
      this._showBroadcast(payload.sayText);
    }
  }

  _updateNowPlayingUI(data) {
    const song = data.currentSong;
    if (!song) return;

    // 切歌时关闭 MV 并重置
    if (this._mvActive) this._closeMv();
    this._hideMvBadge();
    this._mvInfo = null;

    // Update radio player bar (left)
    this.radioSongTitle.textContent = song.title || '未知歌曲';
    this.radioSongArtist.textContent = song.artist || '未知歌手';

    if (song.cover) {
      this.radioAlbumImg.src = song.cover;
      this.radioAlbumImg.style.display = 'block';
      const fallback = this.radioAlbumThumb.querySelector('.radio-thumb-fallback');
      if (fallback) fallback.style.display = 'none';
    } else {
      this.radioAlbumImg.style.display = 'none';
      const fallback = this.radioAlbumThumb.querySelector('.radio-thumb-fallback');
      if (fallback) fallback.style.display = 'flex';
    }

    // Update right-side player elements
    if (this.songTitle) this.songTitle.textContent = song.title || '未知歌曲';
    if (this.songArtist) this.songArtist.textContent = song.artist || '未知歌手';

    // Album art
    if (this.albumArt) {
      if (song.cover) {
        this.albumArt.innerHTML = `<img src="${this._escapeHtml(song.cover)}" alt="${this._escapeHtml(song.title || '')}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">`;
      } else {
        this.albumArt.innerHTML = '<svg viewBox="0 0 64 64" fill="none" width="80" height="80"><circle cx="32" cy="32" r="28" stroke="currentColor" stroke-width="1.5" opacity="0.2"/><path d="M24 44V22l20-4v22" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="22" cy="42" r="4" fill="currentColor" opacity="0.6"/><circle cx="42" cy="38" r="4" fill="currentColor" opacity="0.6"/></svg>';
      }
    }

    // Record disc spin
    if (this.recordDisc) {
      this.recordDisc.classList.toggle('playing', this.state.isPlaying);
      this.recordDisc.classList.add('visible');
    }

    document.title = `${song.title} — Kimmelody`;
  }

  _updatePlayBtn() {
    if (this.state.isPlaying) {
      const pauseIcon = '<path d="M6 4h4v16H6zm8 0h4v16h-4z"/>';
      if (this.radioPlayIcon) this.radioPlayIcon.innerHTML = pauseIcon;
      if (this.playIcon) this.playIcon.innerHTML = pauseIcon;
    } else {
      const playIcon = '<path d="M8 5v14l11-7z"/>';
      if (this.radioPlayIcon) this.radioPlayIcon.innerHTML = playIcon;
      if (this.playIcon) this.playIcon.innerHTML = playIcon;
    }
  }

  _updatePlayState(payload) {
    if (payload.isPlaying !== undefined) {
      // Don't let stale server state override a recent local change.
      // If the user just paused, the local audio.paused reflects truth.
      if (this.audio.src && this.audio.paused !== payload.isPlaying) {
        return;
      }
      this.state.isPlaying = payload.isPlaying;
      this._syncPlayingUI();
    }
  }

  // ── 播报（Chat 中显示为 AI 消息） ──
  _showBroadcast(text) {
    // Dedup: skip if same as last broadcast
    if (text === this._lastBroadcastText) return;
    this._lastBroadcastText = text;

    // Show broadcast bubble (right-side player)
    if (this.broadcastBubble && this.broadcastText) {
      this.broadcastBubble.style.display = 'flex';
      this.broadcastText.textContent = text;
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = setTimeout(() => {
        if (this.broadcastBubble) this.broadcastBubble.style.display = 'none';
      }, 8000);
    }

    // Also add as chat message
    this.state.chatHistory.push({ role: 'assistant', content: text, songs: [], mood: 'neutral' });
    this._renderChatMessage(text, 'ai');
    this._scrollChatToBottom();
  }

  // ── 进度（节流到 ~10fps 减少重绘） ──
  _onTimeUpdate() {
    if (!this.audio.duration) return;
    const now = performance.now();
    if (this._lastProgressUpdate && now - this._lastProgressUpdate < 100) return;
    this._lastProgressUpdate = now;
    const pct = (this.audio.currentTime / this.audio.duration) * 100;
    if (this.progressBar) this.progressBar.value = pct;
    if (this.timeCurrent) this.timeCurrent.textContent = this._formatTime(this.audio.currentTime);
    // Sync lyrics with playback position
    this._syncLyrics();
  }

  async _onSongEnd() {
    // Try preloaded audio first (instant switch) — verify it loaded successfully
    const nextIdx = this.state.currentIndex + 1;
    if (this._nextAudio && this._preloadedNextIndex === nextIdx && this._nextAudio.src
        && this._nextAudio.readyState >= 2) {
      const nextSong = this.state.songs[nextIdx];
      if (nextSong) {
        this.state.currentIndex = nextIdx;
        this.state.currentSong = nextSong;
        this._updateNowPlayingUI(this.state);
        this.audio.src = this._nextAudio.src;
        this.audio.load();
        try {
          await this.audio.play();
          this.state.isPlaying = true;
        } catch {
          this.state.isPlaying = false;
        }
        this._syncPlayingUI();
        this._renderQueue();
        this._fetchAndShowLyrics(nextSong);
        this._preloadNextSong();
        return;
      }
    }

    // Queue exhausted → AI DJ 自动推荐下一批歌曲
    if (this.state.currentIndex >= this.state.songs.length - 1) {
      return this._autoDJNext();
    }

    // Has more songs in queue but preload failed → server fallback
    const data = await this._api('POST', '/api/command', { text: '下一首' });
    if (data?.payload?.currentSong?.url) {
      this.state.songs = data.payload.songs || this.state.songs;
      this.state.currentIndex = data.payload.currentIndex || 0;
      await this._playSong(data.payload.currentSong, this.state.songs, this.state.currentIndex);
    } else {
      this._sendCommand('下一首');
    }
  }

  // ── 队列播完后 DJ 自动推荐 ──
  async _autoDJNext() {
    this._toast('DJ 正在为你挑选下一首歌...');
    const recentHistory = this.state.songs.slice(-5).map(s => `${s.title} - ${s.artist}`).join('、');

    try {
      const messages = [
        ...this.state.chatHistory.slice(-10),
        {
          role: 'user',
          content: `【自动续播】刚才播了：${recentHistory || '无'}。这些歌已经播完了，请为我推荐接下来适合听的2-3首歌。你可以简单聊一下推荐原因，控制在2-3句话内。`,
        },
      ];

      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      const data = await response.json();

      // 显示 DJ 消息
      if (data.reply) {
        this.state.chatHistory.push({
          role: 'assistant',
          content: data.reply,
          songs: data.songs || [],
          mood: data.mood || 'neutral',
        });
        this._renderAIMessage(data.reply, data.songs || []);
      }

      // 播放推荐的第一首歌
      if (data.songs && data.songs.length > 0) {
        const first = data.songs[0];
        await this._playSong(first, data.songs, 0);
      }
    } catch (err) {
      console.warn('[AutoDJ] 推荐失败:', err.message);
      // 静默失败，用户可以手动操作
    }
  }

  _formatTime(secs) {
    if (!secs || !isFinite(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ── 歌词 ──
  async _fetchAndShowLyrics(song) {
    if (!song?.id || !this.lyricsView) return;
    try {
      const data = await this._api('GET', `/api/lyrics?id=${song.id}`);
      const lrc = data?.lrc || data?.tlrc || '';
      if (lrc) {
        this._parseLyrics(lrc);
        this._renderLyrics();
      } else {
        this.lyricsView.innerHTML = '<p class="lyrics-placeholder">🎵 暂无歌词</p>';
        this.lyricLines = [];
      }
    } catch {
      this.lyricsView.innerHTML = '<p class="lyrics-placeholder">🎵 暂无歌词</p>';
      this.lyricLines = [];
    }
  }

  _parseLyrics(lrc) {
    this.lyricLines = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
    for (const line of lrc.split('\n')) {
      const match = line.match(timeRegex);
      if (match) {
        const minutes = parseInt(match[1]);
        const seconds = parseInt(match[2]);
        const millis = parseInt(match[3].padEnd(3, '0'));
        const time = minutes * 60 + seconds + millis / 1000;
        const text = line.replace(timeRegex, '').trim();
        if (text) this.lyricLines.push({ time, text });
      }
    }
  }

  _renderLyrics() {
    if (!this.lyricsView) return;
    if (this.lyricLines.length === 0) {
      this.lyricsView.innerHTML = '<p class="lyrics-placeholder">🎵 暂无歌词</p>';
      return;
    }
    this.lyricsContainer = this.lyricsContainer || document.createElement('div');
    this.lyricsContainer.className = 'lyrics-lines';
    this.lyricsContainer.innerHTML = this.lyricLines.map((l, i) =>
      `<p class="lyrics-line" data-index="${i}">${this._escapeHtml(l.text)}</p>`
    ).join('');
    this.lyricsView.innerHTML = '';
    this.lyricsView.appendChild(this.lyricsContainer);
    this._currentLyricIndex = -1;
  }

  _syncLyrics() {
    if (!this.lyricLines.length || !this.lyricsContainer) return;
    const t = this.audio.currentTime;
    let activeIdx = -1;
    for (let i = 0; i < this.lyricLines.length; i++) {
      if (this.lyricLines[i].time <= t) activeIdx = i;
      else break;
    }
    if (activeIdx === this._currentLyricIndex) return;
    // Remove old active
    const prev = this.lyricsContainer.querySelector('.lyrics-line.active');
    if (prev) prev.classList.remove('active');
    // Set new active
    if (activeIdx >= 0) {
      const el = this.lyricsContainer.querySelector(`[data-index="${activeIdx}"]`);
      if (el) {
        el.classList.add('active');
        // Only scroll if the lyrics view is visible (not display:none)
        if (this.lyricsView && this.lyricsView.offsetParent) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    }
    this._currentLyricIndex = activeIdx;
  }

  // ── 预加载下一首 ──
  _preloadNextSong() {
    // Clean up old preloaded audio
    if (this._nextAudio) {
      this._nextAudio.src = '';
      this._nextAudio = null;
    }
    const nextIdx = this.state.currentIndex + 1;
    const nextSong = this.state.songs[nextIdx];
    if (!nextSong?.url) return;

    this._nextAudio = new Audio();
    this._nextAudio.preload = 'auto';
    this._nextAudio.src = `/api/audio/proxy?url=${encodeURIComponent(nextSong.url)}`;
    this._preloadedNextIndex = nextIdx;
  }

  // ── 队列 ──
  _renderQueue() {
    const items = this.state.songs.length > 0 ? this.state.songs : this.state.queue;
    if (items.length === 0) {
      this.queueList.innerHTML = '<p class="empty-state">队列为空</p>';
      return;
    }

    this.queueList.innerHTML = items.map((song, i) => `
      <div class="queue-item ${i === this.state.currentIndex ? 'active' : ''}">
        <span class="queue-item-index">${i + 1}</span>
        <div class="queue-item-info">
          <div class="queue-item-title">${song.title || '未知'}</div>
          <div class="queue-item-artist">${song.artist || '未知'}</div>
        </div>
      </div>
    `).join('');
  }

  // ── 节目表 ──
  _renderTimeline() {
    if (!this.state.plans || this.state.plans.length === 0) {
      this.timelineList.innerHTML = '<p class="empty-state">今日暂无电台节目安排</p>';
      return;
    }

    this.timelineList.innerHTML = this.state.plans.map(plan => `
      <div class="timeline-card">
        <div class="timeline-time">${plan.plan_time}</div>
        <div class="timeline-info">
          <div class="timeline-name">${plan.scene_name || plan.scene}</div>
          ${plan.say_text ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px">"${plan.say_text.slice(0, 60)}"</div>` : ''}
          <span class="timeline-status ${plan.status}">${plan.status === 'done' ? '已播放' : plan.status === 'pending' ? '待播' : plan.status}</span>
        </div>
      </div>
    `).join('');
  }

  // ── 调度规则 ──
  _renderSchedule() {
    if (!this.state.rules || this.state.rules.length === 0) {
      this.scheduleList.innerHTML = '<p style="color:var(--text-muted);font-size:13px">暂无调度规则</p>';
      return;
    }

    this.scheduleList.innerHTML = this.state.rules.map(rule => `
      <div class="schedule-rule">
        <button class="schedule-switch ${rule.enabled ? 'active' : ''}"
                data-id="${rule.id}"
                data-enabled="${rule.enabled}"></button>
        <span class="schedule-rule-name">${rule.name}</span>
        <span class="schedule-rule-time">${rule.cron}</span>
      </div>
    `).join('');

    // 切换开关
    this.scheduleList.querySelectorAll('.schedule-switch').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const enabled = btn.dataset.enabled === '1' ? 0 : 1;
        btn.dataset.enabled = enabled;
        btn.classList.toggle('active');
        await this._api('PUT', `/api/schedule/${id}`, { enabled: !!enabled });
        this._toast(enabled ? '已启用' : '已关闭');
      });
    });
  }

  // ── 推荐 ──
  async _fetchRecommendations() {
    if (!this.recommendContent) return;
    this.recommendContent.innerHTML = '<p class="empty-state">加载中...</p>';
    const data = await this._api('GET', '/api/recommendations');
    if (!data) {
      this.recommendContent.innerHTML = '<p class="empty-state">加载失败，请稍后再试</p>';
      return;
    }
    this._renderRecommendations(data);
  }

  _renderRecommendations(data) {
    if (!this.recommendContent) return;
    let html = '';

    if (data.loggedIn && data.profile) {
      // Profile header
      html += `
        <div class="user-profile">
          <img class="user-avatar" src="${this._escapeHtml(data.profile.avatarUrl)}" alt="avatar" onerror="this.style.display='none'">
          <div class="user-info">
            <div class="user-name">${this._escapeHtml(data.profile.nickname)}</div>
            <div class="user-liked">❤️ ${data.likedCount || 0} 首收藏 · ${data.userPlaylists?.length || 0} 个歌单</div>
          </div>
        </div>
      `;

      // Top songs (recently played)
      if (data.topSongs && data.topSongs.length > 0) {
        html += `<h3 class="rec-section-title">近期常听</h3>`;
        html += `<div class="top-songs-list">`;
        data.topSongs.forEach(s => {
          html += `
            <div class="top-song-item">
              <div class="top-song-info">
                <div class="top-song-title">${this._escapeHtml(s.title)}</div>
                <div class="top-song-artist">${this._escapeHtml(s.artist)}</div>
              </div>
              <span class="top-song-score" style="font-size:12px;color:var(--text-muted)">${s.score}</span>
            </div>
          `;
        });
        html += `</div>`;
      }

      // User playlists
      if (data.userPlaylists && data.userPlaylists.length > 0) {
        html += `<h3 class="rec-section-title">我的歌单</h3>`;
        html += this._renderPlaylistGrid(data.userPlaylists);
      }
    } else {
      html += `<div class="rec-not-logged-in">
        <p>未登录网易云账号</p>
        <p class="rec-hint">登录后可查看个性化推荐</p>
      </div>`;
    }

    // Recommended playlists
    if (data.recommendPlaylists && data.recommendPlaylists.length > 0) {
      html += `<h3 class="rec-section-title">推荐歌单</h3>`;
      html += this._renderPlaylistGrid(data.recommendPlaylists);
    }

    this.recommendContent.innerHTML = html || '<p class="empty-state">暂无推荐内容</p>';

    // Bind playlist card clicks
    this.recommendContent.querySelectorAll('.playlist-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        if (id) this._openPlaylist(id);
      });
    });
  }

  _renderPlaylistGrid(playlists) {
    return `<div class="playlist-grid">${playlists.map(p => `
      <div class="playlist-card" data-id="${this._escapeHtml(String(p.id))}">
        <div class="playlist-cover-wrap">
          <img class="playlist-cover" src="${this._escapeHtml(p.cover || '')}" alt="${this._escapeHtml(p.name)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'playlist-fallback\\'>🎵</div>'">
        </div>
        <div class="playlist-name">${this._escapeHtml(p.name)}</div>
        <div class="playlist-count">${p.trackCount || 0} 首</div>
      </div>
    `).join('')}</div>`;
  }

  async _openPlaylist(playlistId) {
    this._toast('加载歌单歌曲...');
    const tracks = await this._api('GET', `/api/playlist/${playlistId}/tracks`).catch(() => null);
    if (tracks?.tracks?.length > 0) {
      const first = tracks.tracks[0];
      const ok = await this._playSong(first, tracks.tracks, 0);
      if (ok) this._toast(`正在播放: ${first.title}`);
    } else {
      this._toast('获取歌单歌曲失败');
    }
  }

  // ── 音量 ──
  _setVolume(val) {
    const vol = parseInt(val);
    this.volumeLabel.textContent = `${vol}%`;
    this.volumeSlider.value = vol;
    this.volumeQuickLabel.textContent = `${vol}%`;
    this.volumeQuickSlider.value = vol;
    this.audio.volume = vol / 100;
    this.state.volume = vol;
    this._api('POST', '/api/command', { text: `音量调到${vol}` });
  }

  // ── 搜索 ──
  _toggleSearch(show) {
    this.searchOverlay?.classList.toggle('active', show);
    if (show) {
      this.searchInput?.focus();
      this.searchResults.innerHTML = '';
    } else {
      this.searchInput.value = '';
      this.searchResults.innerHTML = '';
    }
  }

  async _doSearch(query) {
    const q = query.trim();
    if (!q) return;
    this.searchResults.innerHTML = '<p class="empty-state">搜索中...</p>';
    const data = await this._api('GET', `/api/search?q=${encodeURIComponent(q)}&limit=10`);
    if (!data?.results?.length) {
      this.searchResults.innerHTML = '<p class="empty-state">未找到相关歌曲</p>';
      return;
    }
    this.searchResults.innerHTML = data.results.map(song => `
      <div class="search-result-item" data-id="${song.id}" data-title="${this._escapeHtml(song.title)}" data-artist="${this._escapeHtml(song.artist)}" data-cover="${this._escapeHtml(song.cover || '')}">
        <div class="search-result-cover">
          ${song.cover ? `<img src="${this._escapeHtml(song.cover)}" alt="">` : '<div class="search-fallback">🎵</div>'}
        </div>
        <div class="search-result-info">
          <div class="search-result-title">${this._escapeHtml(song.title)}</div>
          <div class="search-result-artist">${this._escapeHtml(song.artist)}</div>
        </div>
        <button class="search-add-btn" title="添加到队列">+</button>
      </div>
    `).join('');

    // Click item → play directly
    this.searchResults.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const song = {
          id: item.dataset.id,
          title: item.dataset.title,
          artist: item.dataset.artist,
          cover: item.dataset.cover,
        };
        this._resolveAndPlaySong(song);
        this._toggleSearch(false);
      });
    });

    // Click + button → add to queue
    this.searchResults.querySelectorAll('.search-add-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.search-result-item');
        const song = {
          id: item.dataset.id,
          title: item.dataset.title,
          artist: item.dataset.artist,
          cover: item.dataset.cover,
        };
        await this._api('POST', '/api/queue', { song });
        this._toast(`已添加: ${song.title}`);
      });
    });
  }

  // ── 发送命令 ──
  _sendCommand(text) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'user:command', text }));
    } else {
      this._api('POST', '/api/command', { text });
    }
  }

  // ── 视图切换 ──
  _switchView(viewId) {
    const targetKey = viewId.replace('view', '').toLowerCase();
    Object.keys(this.views).forEach(key => {
      this.views[key].classList.toggle('active', key.toLowerCase() === targetKey);
    });
    this.navItems.forEach(item => {
      item.classList.toggle('active', item.dataset.view === viewId);
    });

    // 切换时刷新数据
    if (viewId === 'viewTimeline') {
      this._api('GET', '/api/plan/today').then(data => {
        if (data) { this.state.plans = data; this._renderTimeline(); }
      });
    }
    if (viewId === 'viewQueue') {
      this._api('GET', '/api/queue').then(data => {
        if (data?.queue) { this.state.queue = data.queue; this._renderQueue(); }
      });
    }
    if (viewId === 'viewRecommend') {
      this._fetchRecommendations();
    }
  }

  // ── Toast ──
  _toast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ── Splash ──
  _hideSplash() {
    setTimeout(() => this.splash?.classList.add('hidden'), 600);
  }

  // ── 移动端播放栏切换 ──
  _toggleMobilePlayer() {
    if (this.radioPlayerCol) {
      this.radioPlayerCol.classList.toggle('open');
    }
  }

  // ══════════════════════════════════════════
  //  Chat Methods
  // ══════════════════════════════════════════

  _showWelcomeMessage() {
    const hour = new Date().getHours();
    let greeting = '';
    if (hour < 6) greeting = '夜深了，想听些安静的音乐助眠吗？';
    else if (hour < 9) greeting = '早上好！新的一天开始了，想听点什么样的音乐？';
    else if (hour < 12) greeting = '上午好！有首好歌能点亮整个上午。';
    else if (hour < 14) greeting = '午安！来点轻松的音乐放松一下。';
    else if (hour < 18) greeting = '下午好！需要音乐陪伴工作还是想发现新歌？';
    else greeting = '晚上好！今天想听什么样的音乐？';

    this.state.chatHistory.push({ role: 'assistant', content: greeting, songs: [], mood: 'neutral' });
    this._renderAIMessage(greeting, []);
  }

  async _sendChatMessage() {
    const text = this.chatInput.value.trim();
    if (!text || this.state.chatSending) return;

    this.chatInput.value = '';
    this.chatSendBtn.disabled = true;
    this.state.chatSending = true;

    // 1. Add user message to chat
    this.state.chatHistory.push({ role: 'user', content: text });
    this._renderChatMessage(text, 'user');

    // 2. Create streaming AI message placeholder
    const aiDiv = document.createElement('div');
    aiDiv.className = 'chat-message ai';
    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar ai';
    avatar.innerHTML = '<img src="/ai.png" alt="DJ" width="28" height="28" style="border-radius:50%;object-fit:cover">';
    const contentWrap = document.createElement('div');
    contentWrap.style.flex = '1';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ai streaming';
    bubble.textContent = '⏳';
    contentWrap.appendChild(bubble);
    aiDiv.appendChild(avatar);
    aiDiv.appendChild(contentWrap);
    this.chatMessages.appendChild(aiDiv);
    this._scrollChatToBottom();

    // 3. Stream from API via SSE
    let fullRaw = '';
    const recentMessages = this.state.chatHistory.slice(-20);
    try {
      const response = await fetch(`${API_BASE}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: recentMessages }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6);
          try {
            const data = JSON.parse(jsonStr);

            if (data.type === 'text') {
              fullRaw += data.text;
              // 从 JSON 中实时提取 reply 文本，不显示 JSON 结构
              const displayText = this._extractReplyFromJSON(fullRaw);
              if (displayText) {
                bubble.textContent = displayText;
                bubble.classList.remove('streaming');
                this._scrollChatToBottom();
              }
            } else if (data.type === 'done') {
              bubble.textContent = data.reply || fullReply;
              bubble.classList.remove('streaming');

              this.state.chatHistory.push({
                role: 'assistant',
                content: data.reply || fullReply,
                songs: data.songs || [],
                mood: data.mood || 'neutral',
              });

              // Render song cards
              if (data.songs && data.songs.length > 0) {
                this._appendSongCards(contentWrap, data.songs);
              }

              // Update mood
              if (data.mood && data.mood !== this.state.lastMood) {
                this.state.lastMood = data.mood;
                this._updateMoodVisual(data.mood);
              }

              // Auto-play TTS
              if (data.tts_url) {
                this._playChatTTS(data.tts_url);
              }
            } else if (data.type === 'error') {
              bubble.textContent = data.message;
              bubble.classList.remove('streaming');
            }
          } catch { /* skip unparseable lines */ }
        }
      }
    } catch (err) {
      bubble.textContent = '网络出了点问题，能再试一次吗？';
      bubble.classList.remove('streaming');
      console.error('[Chat] stream error:', err);
    }

    this._scrollChatToBottom();
    this.state.chatSending = false;
  }

  // 追加歌曲卡片到已有的 AI 消息中
  _appendSongCards(container, songs) {
    const cardsContainer = document.createElement('div');
    cardsContainer.className = 'chat-song-cards';

    songs.forEach(song => {
      const card = document.createElement('div');
      card.className = 'chat-song-card';
      card.dataset.songId = String(song.id);

      const cover = document.createElement('div');
      cover.className = 'chat-song-cover';
      if (song.cover) {
        cover.innerHTML = `<img src="${song.cover}" alt="${this._escapeHtml(song.title)}" loading="lazy">`;
      } else {
        cover.textContent = '🎵';
      }

      const info = document.createElement('div');
      info.className = 'chat-song-info';
      info.innerHTML = `
        <div class="chat-song-name">${this._escapeHtml(song.title || '未知')}</div>
        <div class="chat-song-artist">${this._escapeHtml(song.artist || '')}</div>
        ${song.reason ? `<div class="chat-song-reason">${this._escapeHtml(song.reason)}</div>` : ''}
      `;

      const playBtn = document.createElement('button');
      playBtn.className = 'chat-song-play';
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._playChatSong(song);
      });

      card.addEventListener('click', () => this._playChatSong(song));
      card.appendChild(cover);
      card.appendChild(info);
      card.appendChild(playBtn);
      cardsContainer.appendChild(card);
    });

    container.appendChild(cardsContainer);
  }

  _renderChatMessage(text, role = 'user') {
    const div = document.createElement('div');
    div.className = `chat-message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = `chat-avatar ${role}`;
    if (role === 'ai') {
      avatar.innerHTML = '<img src="/ai.png" alt="DJ" width="28" height="28" style="border-radius:50%;object-fit:cover">';
    } else {
      avatar.innerHTML = '<img src="/user.png" alt="我" width="28" height="28" style="border-radius:50%;object-fit:cover">';
    }

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role}`;
    bubble.textContent = text;

    div.appendChild(avatar);
    div.appendChild(bubble);
    this.chatMessages.appendChild(div);
    this._scrollChatToBottom();
  }

  _renderAIMessage(reply, songs) {
    const div = document.createElement('div');
    div.className = 'chat-message ai';

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar ai';
    avatar.innerHTML = '<img src="/ai.png" alt="DJ" width="28" height="28" style="border-radius:50%;object-fit:cover">';

    const content = document.createElement('div');
    content.style.flex = '1';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ai';
    bubble.textContent = reply;
    content.appendChild(bubble);

    // Render song cards below the bubble
    if (songs && songs.length > 0) {
      const cardsContainer = document.createElement('div');
      cardsContainer.className = 'chat-song-cards';

      songs.forEach(song => {
        const card = document.createElement('div');
        card.className = 'chat-song-card';
        card.dataset.songId = String(song.id);

        const cover = document.createElement('div');
        cover.className = 'chat-song-cover';
        if (song.cover) {
          cover.innerHTML = `<img src="${song.cover}" alt="${song.title}" loading="lazy">`;
        } else {
          cover.textContent = '🎵';
        }

        const info = document.createElement('div');
        info.className = 'chat-song-info';
        info.innerHTML = `
          <div class="chat-song-name">${this._escapeHtml(song.title || '未知')}</div>
          <div class="chat-song-artist">${this._escapeHtml(song.artist || '')}</div>
          ${song.reason ? `<div class="chat-song-reason">${this._escapeHtml(song.reason)}</div>` : ''}
        `;

        const playBtn = document.createElement('button');
        playBtn.className = 'chat-song-play';
        playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._playChatSong(song);
        });

        card.addEventListener('click', () => this._playChatSong(song));

        card.appendChild(cover);
        card.appendChild(info);
        card.appendChild(playBtn);
        cardsContainer.appendChild(card);
      });

      content.appendChild(cardsContainer);
    }

    div.appendChild(avatar);
    div.appendChild(content);
    this.chatMessages.appendChild(div);
    this._scrollChatToBottom();
  }

  async _playChatSong(song) {
    const ok = await this._playSong(song, [song], 0);
    if (ok) {
      this.chatMessages.querySelectorAll('.chat-song-card').forEach(c => {
        c.classList.toggle('playing', c.dataset.songId === String(song.id));
      });
    }
  }

  _playChatTTS(url) {
    if (!url) return;
    const ttsAudio = new Audio(url);
    ttsAudio.volume = 0.6;
    ttsAudio.play().catch(() => {});
  }

  _showTypingIndicator() {
    if (this._typingEl) return;
    const div = document.createElement('div');
    div.className = 'chat-message ai';
    div.id = 'chatTyping';

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar ai';
    avatar.innerHTML = '<img src="/ai.png" alt="DJ" width="28" height="28" style="border-radius:50%;object-fit:cover">';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ai chat-typing';
    bubble.innerHTML = '<span></span><span></span><span></span>';

    div.appendChild(avatar);
    div.appendChild(bubble);
    this.chatMessages.appendChild(div);
    this._scrollChatToBottom();
    this._typingEl = div;
  }

  _removeTypingIndicator() {
    const el = document.getElementById('chatTyping');
    if (el) el.remove();
    this._typingEl = null;
  }

  _scrollChatToBottom() {
    requestAnimationFrame(() => {
      this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    });
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // 从部分 JSON 中提取 reply 字段文本（用于流式输出时不显示 JSON 结构）
  _extractReplyFromJSON(buffer) {
    const key = '"reply"';
    const keyIdx = buffer.indexOf(key);
    if (keyIdx === -1) return '';

    let start = buffer.indexOf('"', keyIdx + key.length);
    if (start === -1) return '';
    start++;

    let result = '';
    for (let i = start; i < buffer.length; i++) {
      if (buffer[i] === '\\' && i + 1 < buffer.length) {
        const escaped = buffer[i + 1];
        // 只还原常见转义字符
        if (escaped === 'n' || escaped === 'r' || escaped === 't') break; // 遇到换行等不是真正的文本转义
        result += escaped;
        i++;
      } else if (buffer[i] === '"') {
        break;
      } else {
        result += buffer[i];
      }
    }
    return result;
  }

  // DJ 主动聊天 — 一首歌里触发多次，而不是只讲一次故事
  _scheduleSongStory(song) {
    this._clearStoryTimers();
    if (!song || !song.title || !song.artist) return;

    const duration = (song.duration && song.duration > 0) ? song.duration : null;

    // 三种聊天类型
    const rounds = [
      { label: 'story', delay: duration ? Math.min(30, duration * 0.25) : 30 },
      { label: 'chat',   delay: duration ? duration * 0.55 : 100 },
      { label: 'story',  delay: duration ? duration * 0.78 : 180 },
    ];

    this._storyTimers = rounds.map(r => {
      return setTimeout(() => {
        if (r.label === 'chat') {
          this._djCasualChat(song);
        } else {
          this._fetchSongStory(song.title, song.artist);
        }
      }, r.delay * 1000);
    });
  }

  _clearStoryTimers() {
    if (this._storyTimers) {
      this._storyTimers.forEach(t => clearTimeout(t));
      this._storyTimers = null;
    }
  }

  // DJ 主动发起轻松聊天（不限于歌曲故事，更像真人 DJ 互动）
  async _djCasualChat(song) {
    try {
      const messages = [
        ...this.state.chatHistory.slice(-8),
        {
          role: 'user',
          content: `【自动互动】你正在播放《${song.title}》- ${song.artist}。请用1-2句话和听众轻松互动一下——可以是问问心情、聊聊这首歌的感觉、或者分享一个小趣事。不需要推荐新歌（songs 设为空数组），只要自然聊天就好。`,
        },
      ];

      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      const data = await response.json();
      const text = data?.reply || '';
      if (text) {
        this.state.chatHistory.push({
          role: 'assistant',
          content: text,
          songs: [],
          mood: this.state.lastMood || 'neutral',
        });
        this._renderAIMessage(text, []);
      }
    } catch (err) {
      // 静默失败，不打扰用户听歌
    }
  }

  async _fetchSongStory(title, artist) {
    try {
      const data = await this._api('POST', '/api/song/story', { title, artist });
      if (data && data.story) {
        this.state.chatHistory.push({
          role: 'assistant',
          content: data.story,
          songs: [],
          mood: this.state.lastMood || 'neutral',
        });
        this._renderAIMessage(data.story, []);
      }
    } catch (err) {
      console.warn('[Story] fetch error:', err.message);
    }
  }

  // ══════════════════════════════════════════
  //  Wave Visualizer
  // ══════════════════════════════════════════

  _initAudioAnalyser() {
    // Only create AudioContext; do NOT route audio yet.
    // createMediaElementSource permanently disconnects <audio> from speakers,
    // so we defer it until the AudioContext is confirmed running.
    if (this._audioCtx || this._audioInitAttempted || !this.waveCanvas) return;
    this._audioInitAttempted = true;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AudioCtx();
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 256;
      this._audioDataArray = new Uint8Array(this._analyser.frequencyBinCount);
    } catch (e) {
      console.warn('[Audio] Failed to create AudioContext:', e.message);
      this._audioCtx = null;
      this._analyser = null;
      this._audioInitAttempted = false;
    }
    this._initWaveCanvas();
  }

  _routeAudioThroughAnalyser() {
    // Call this ONLY after AudioContext is confirmed 'running'.
    // createMediaElementSource can only be called once per audio element.
    if (this._audioCtxReady || !this._audioCtx || !this._analyser) return;
    try {
      this._audioSource = this._audioCtx.createMediaElementSource(this.audio);
      this._audioSource.connect(this._analyser);
      this._audioSource.connect(this._audioCtx.destination);
      this._audioCtxReady = true;
    } catch (e) {
      // If createMediaElementSource fails (already called), the audio may
      // already be routed. Don't null out the context — keep it alive.
      console.warn('[Audio] Audio routing failed (may already be routed):', e.message);
      this._audioCtxReady = false;
    }
  }

  async _resumeAudioContext() {
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      try {
        await this._audioCtx.resume();
      } catch {
        // Keep _audioCtx intact; don't flip _audioCtxReady here
      }
    }
    // Once context is running, route audio through analyser if not yet done
    if (this._audioCtx && this._audioCtx.state === 'running' && !this._audioCtxReady) {
      this._routeAudioThroughAnalyser();
    }
  }

  _initWaveCanvas() {
    if (!this.waveCanvas) return;
    this._waveCtx = this.waveCanvas.getContext('2d');
    this._resizeWaveCanvas();
    window.addEventListener('resize', () => this._resizeWaveCanvas());
    this._startWaveLoop();
  }

  _resizeWaveCanvas() {
    if (!this.waveCanvas) return;
    const rect = this.waveCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.waveCanvas.width = rect.width * dpr;
    this.waveCanvas.height = rect.height * dpr;
    this._waveCtx.scale(dpr, dpr);
    this._waveWidth = rect.width;
    this._waveHeight = rect.height;
  }

  _startWaveLoop() {
    const draw = () => {
      this._animFrameId = requestAnimationFrame(draw);
      if (!this._waveCtx) return;

      if (this._audioCtxReady && this.state.isPlaying && this._analyser) {
        this._drawFrequencyBars();
      } else {
        this._drawIdleWave();
      }
    };
    draw();
  }

  _drawFrequencyBars() {
    const ctx = this._waveCtx;
    const w = this._waveWidth;
    const h = this._waveHeight;

    this._analyser.getByteFrequencyData(this._audioDataArray);

    ctx.clearRect(0, 0, w, h);

    const barCount = 64;
    const step = Math.floor(this._audioDataArray.length / barCount);
    const barWidth = (w / barCount) * 0.7;
    const gap = (w / barCount) * 0.3;

    const style = getComputedStyle(document.documentElement);
    const color1 = style.getPropertyValue('--wave-color-1').trim() || '#a78bfa';
    const color2 = style.getPropertyValue('--wave-color-2').trim() || '#7c5cbf';

    for (let i = 0; i < barCount; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += this._audioDataArray[i * step + j] || 0;
      }
      const avg = sum / step;
      const normalized = Math.max(0.05, avg / 255);
      const barHeight = normalized * h * 0.8;
      const x = i * (barWidth + gap);
      const y = h - barHeight;

      ctx.fillStyle = ctx.createLinearGradient(x, h, x, y);
      ctx.fillStyle.addColorStop(0, color1);
      ctx.fillStyle.addColorStop(1, color2);

      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, [2, 2, 0, 0]);
      ctx.fill();
    }
  }

  _drawIdleWave() {
    const ctx = this._waveCtx;
    const w = this._waveWidth;
    const h = this._waveHeight;

    ctx.clearRect(0, 0, w, h);

    const style = getComputedStyle(document.documentElement);
    const color1 = style.getPropertyValue('--wave-color-1').trim() || '#a78bfa';

    ctx.beginPath();
    ctx.strokeStyle = color1;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.3;

    const amplitude = h * 0.2;
    const frequency = 0.02;
    const phase = (Date.now() / 1000) * 0.8;

    for (let x = 0; x < w; x++) {
      const y = h / 2 + Math.sin(x * frequency + phase) * amplitude;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _updateMoodVisual(mood) {
    if (!this.radioView) return;
    const moods = ['energetic', 'calm', 'happy', 'melancholic', 'focused', 'nostalgic'];
    moods.forEach(m => this.radioView.classList.remove(`chat-mood-${m}`));
    if (moods.includes(mood)) {
      this.radioView.classList.add(`chat-mood-${mood}`);
    }
  }

  // ══════════════════════════════════════════
  //  MV Player
  // ══════════════════════════════════════════

  async _checkMvAvailability(song) {
    if (this._mvChecking || !song?.id) return;
    this._mvChecking = true;
    try {
      const data = await this._api('GET', `/api/mv/${song.id}`);
      if (data?.hasMv) {
        this._mvInfo = { mvId: data.mvId, detail: data.detail, songId: song.id };
        this._showMvBadge();
      }
    } catch {
      // 静默
    } finally {
      this._mvChecking = false;
    }
  }

  _showMvBadge() {
    if (this.mvBadge) this.mvBadge.style.display = 'flex';
  }

  _hideMvBadge() {
    if (this.mvBadge) this.mvBadge.style.display = 'none';
  }

  async _enterMv() {
    if (!this._mvInfo?.songId) {
      this._toast('该 MV 暂时无法播放');
      return;
    }

    this._hideMvBadge();
    if (this.mvLoading) this.mvLoading.style.display = 'flex';

    const currentTime = this.audio.currentTime || 0;
    // 记录音频原始播放状态，供 _closeMv 恢复用
    this._mvWasPlaying = this.state.isPlaying;

    this.audio.pause();

    // 每次点击都重新获取新鲜 MV URL（避免缓存的 URL 已过期）
    let freshUrl = null;
    try {
      const data = await this._api('GET', `/api/mv/${this._mvInfo.songId}`);
      freshUrl = data?.url || null;
    } catch {
      // 继续
    }
    if (!freshUrl) {
      this._closeMv();
      this._toast('MV 暂时无法加载，请稍后重试');
      return;
    }

    const proxyUrl = `/api/mv/proxy?url=${encodeURIComponent(freshUrl)}`;
    this.mvVideo.src = proxyUrl;
    this.mvVideo.style.display = 'block';
    // 静音播放绕过浏览器自动播放策略
    this.mvVideo.muted = true;

    try {
      await this.mvVideo.play();
      // play() 成功后再取消静音
      this.mvVideo.muted = false;
      // 恢复播放状态
      if (!this._mvWasPlaying) this.mvVideo.pause();
      this.mvVideo.currentTime = currentTime;

      this._mvActive = true;
      this.state.isPlaying = !this.mvVideo.paused;
      this._syncPlayingUI();

      if (this.mvControls) this.mvControls.style.display = 'flex';
      if (this.recordDisc) this.recordDisc.classList.remove('visible');
    } catch (err) {
      console.warn('[MV] play() rejected:', err.message);
      this._closeMv();
      this._toast('MV 播放失败，请重试');
    }
  }

  _closeMv() {
    const currentTime = this.mvVideo.currentTime || 0;
    // 优先使用 _enterMv 保存的音频原始状态，否则根据视频状态判断
    const wasPlaying = this._mvWasPlaying !== undefined
      ? this._mvWasPlaying
      : !this.mvVideo.paused;
    this._mvWasPlaying = undefined;

    this.mvVideo.pause();
    this.mvVideo.muted = false;
    this.mvVideo.style.display = 'none';
    this.mvVideo.removeAttribute('src');
    this.mvLoading.style.display = 'none';
    this.mvControls.style.display = 'none';
    this._mvActive = false;

    // 恢复音频
    if (this.audio.src) {
      this.audio.currentTime = currentTime;
      if (wasPlaying) {
        this.audio.play().then(() => {
          this.state.isPlaying = true;
          this._syncPlayingUI();
        }).catch(() => {
          this.state.isPlaying = false;
          this._syncPlayingUI();
        });
      } else {
        this.state.isPlaying = false;
        this._syncPlayingUI();
      }
    }

    // 恢复显示 MV 标签
    if (this._mvInfo) this._showMvBadge();
  }

  _toggleMvFullscreen() {
    if (!this.mvVideo) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      const el = this.mvVideo.parentElement || this.mvVideo;
      el.requestFullscreen?.().catch(() => {});
    }
  }
}

// ── 启动 ──
document.addEventListener('DOMContentLoaded', () => {
  window.app = new KimmelodyApp();
});
