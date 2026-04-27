# Kimmelody AI 音乐电台 — 技术实现文档

---

## 一、架构总览

### 1.1 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PWA 前端 (packages/web)                       │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│   │ NowPlaying│  │ Playlist │  │ Timeline │  │ Settings/Profile  │  │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────────┬─────────┘  │
│        └──────────────┴─────────────┴──────────────────┘             │
│                           WebSocket ▲ HTTP                           │
└────────────────────────────────────┼─────────────────────────────────┘
                                     │
┌────────────────────────────────────┼─────────────────────────────────┐
│               HTTP/WS 网关 (packages/server/src/api/)                 │
│   ┌──────────────┐         ┌──────────────────┐                     │
│   │  http.js     │         │    ws.js         │                     │
│   │  REST API    │         │  实时推送 + 指令   │                     │
│   └──────┬───────┘         └────────┬─────────┘                     │
└──────────┼──────────────────────────┼───────────────────────────────┘
           │                          │
┌──────────▼──────────────────────────▼───────────────────────────────┐
│                     核心服务 (packages/server/src/modules/)           │
│                                                                      │
│   ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐              │
│   │ Router │───▶│Context │───▶│ Claude │───▶│Executor│              │
│   │意图分流  │    │Prompt组装│    │模型交互 │   │指令执行  │             │
│   └────────┘    └────────┘    └────┬───┘    └───┬────┘              │
│                                     │            │                    │
│   ┌────────┐    ┌────────┐    ┌────▼───┐    ┌───▼────┐              │
│   │Scheduler│   │  TTS   │    │ Music  │    │ State   │              │
│   │ 节律调度 │    │声音管线 │    │ API封装 │    │ 持久化   │             │
│   └────────┘    └────────┘    └────────┘    └────────┘              │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心数据流

```
[触发]                                [执行]
   │                                      │
   ├─ Scheduler 定时唤醒 ───┐              │
   │                        ▼              │
   ├─ 用户指令 → Router ──▶ Context ──┬▶ Claude ──▶ Executor ──▶ WS 推送
   │                                  │            │
   ├─ 外部事件 (天气/日程变更) ─────────┘            │
   │                                                ▼
   │                                          ┌──────────┐
   │                                          │ TTS 合成  │──▶ 音频推流
   │                                          │ Music API │──▶ 歌曲直链
   │                                          │ State.db  │──▶ 记录历史
   │                                          └──────────┘
```

### 1.3 处理时序（以早间电台为例）

```
Scheduler            Context          Claude           Music API       TTS         WS Frontend
    │                    │               │                 │             │              │
    │──cron:07:00──▶     │               │                 │             │              │
    │                    │──read taste──▶│                 │             │              │
    │                    │──fetch weather▶│                 │             │              │
    │                    │──fetch agenda─▶│                 │             │              │
    │                    │──read history─▶│                 │             │              │
    │                    │               │                 │             │              │
    │                    │◀──{say,play}──│                 │             │              │
    │                    │               │                 │             │              │
    │                    │──for each song─────────────────▶│             │              │
    │                    │               │           ◀──song_url────     │              │
    │                    │               │                 │             │              │
    │                    │──say_text──────────────────────────────────▶  │              │
    │                    │               │                 │       ◀──mp3               │
    │                    │               │                 │             │              │
    │                    │◀───{song, say, lyric}───────────────────────────────────────▶│
    │                    │               │                 │             │              │
    │                    │──write history to State.db      │             │              │
```

---

## 二、模块详细实现

### 2.1 State — 持久化层 (`src/modules/state.js`)

```js
// state.js — 基于 better-sqlite3 的同步操作封装
// 同步 API 设计原因：SQLite 本地操作延迟 < 1ms，同步代码更简洁

const Database = require('better-sqlite3');
const path = require('path');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS play_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    artist      TEXT NOT NULL,
    album       TEXT,
    duration    INTEGER,
    played_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    scene       TEXT,
    reason      TEXT,
    skipped     BOOLEAN DEFAULT 0,
    rating      INTEGER
  );

  CREATE TABLE IF NOT EXISTS scheduled_plans (...);  -- 同 need.md
  CREATE TABLE IF NOT EXISTS user_feedback (...);
  CREATE TABLE IF NOT EXISTS tts_cache (...);
  CREATE TABLE IF NOT EXISTS playlists (...);
  CREATE TABLE IF NOT EXISTS schedule_rules (...);
`;

class State {
  constructor(dbPath) {
    this.db = new Database(path.resolve(dbPath));
    this.db.pragma('journal_mode = WAL');  // 高并发读取
    this.db.exec(SCHEMA);
  }

  // —— 播放历史 ——
  addHistory(entry) { /* INSERT */ }
  getHistory({ limit = 50, offset = 0, scene }) { /* SELECT */ }
  getRecentSongs(hours = 24) { /* 获取近期播放 */ }
  getSkipRate(songId) { /* 跳过率统计 */ }

  // —— 用户反馈 ——
  addFeedback(songId, feedback, context) { /* INSERT */ }
  getDislikedGenres() { /* 统计不喜欢的风格 */ }

  // —— 调度计划 ——
  savePlan(plan) { /* INSERT OR REPLACE */ }
  getTodaysPlans() { /* 查询当天计划 */ }
  updatePlanStatus(id, status) { /* UPDATE */ }

  // —— TTS 缓存 ——
  getCachedTts(hash) { /* SELECT */ }
  saveTtsCache(hash, voice, filePath) { /* INSERT */ }

  // —— 调度规则 ——
  getEnabledRules() { /* SELECT WHERE enabled=1 */ }

  // —— 工具 ——
  close() { this.db.close(); }
}
```

### 2.2 Router — 意图分流 (`src/modules/router.js`)

#### 分流逻辑

```js
// 优先级：精确命令 > 场景指令 > 自然语言
//
// 匹配策略：
//   1. 精确匹配：定义 INTENT_MAP，正则匹配常见短语
//   2. 模糊匹配：未命中精确规则时，交由 Claude 处理
//   3. 上下文消歧：引用"这个""那首"时回溯播放历史

const INTENT_MAP = [
  // ── 播放控制（直连执行，无需模型调用）──
  { pattern: /^(播放|暂停|停一下|继续)/,            intent: 'toggle_play' },
  { pattern: /^(下一[首曲]|切歌|跳过)/,             intent: 'next_song' },
  { pattern: /^上一[首曲]/,                         intent: 'prev_song' },
  { pattern: /^音量\s*(调到?|设为?|改成?)?\s*(\d+)/, intent: 'volume_set', parse: (m) => parseInt(m[2]) },
  { pattern: /^大[声点]/,                           intent: 'volume_up' },
  { pattern: /^小[声点]/,                           intent: 'volume_down' },
  { pattern: /^(静音|闭嘴|mute)/,                   intent: 'mute' },

  // ── 设备控制（直连执行）──
  { pattern: /^切(换)?(到)?\s*(音响|喇叭|音箱|蓝牙)/, intent: 'switch_speaker' },
  { pattern: /^切(换)?(到)?\s*耳机/,                intent: 'switch_headphones' },
  { pattern: /^有(哪)?些设备/,                      intent: 'list_devices' },

  // ── 信息查询（直连返回）──
  { pattern: /^现在(在)?放(的)?(什么|哪首)/,         intent: 'now_playing' },
  { pattern: /^今[天日]计划/,                        intent: 'today_plan' },

  // ── 复杂请求（交予 Claude）──
  // 未命中以上任何规则 → intent: 'claude'
];

class Router {
  constructor(state) {
    this.state = state;
  }

  route(input) {
    const text = input.trim();

    // 1. 精确/正则匹配
    for (const rule of INTENT_MAP) {
      const match = text.match(rule.pattern);
      if (match) {
        const payload = rule.parse ? rule.parse(match) : null;
        return { intent: rule.intent, payload, raw: text };
      }
    }

    // 2. 检查上下文引用（含"这个""那首""刚才"等）
    if (/(这个|那个|这首|那首|刚才|刚刚)/.test(text)) {
      const lastSong = this.state.getRecentSongs(2)[0];
      if (lastSong) {
        return { intent: 'claude', context: { referringSong: lastSong }, raw: text };
      }
    }

    // 3. 默认走 Claude
    return { intent: 'claude', raw: text };
  }
}
```

### 2.3 Context — Prompt 组装 (`src/modules/context.js`)

```js
// context.js — 构建传给 Claude 的完整 prompt

class Context {
  constructor({ state, tastePath, routinesPath }) {
    this.state = state;
    this.taste = fs.readFileSync(tastePath, 'utf-8');
    this.routines = fs.readFileSync(routinesPath, 'utf-8');
  }

  async build(trigger) {
    const now = new Date();
    const [
      weather,
      agenda,
      history,
      feedback
    ] = await Promise.all([
      Weather.getCurrent(),             // OpenWeatherMap
      Calendar.getTodayAgenda(),        // 飞书 / iCal
      this.state.getHistory({ limit: 10 }),
      this.state.getDislikedGenres(),
    ]);

    return {
      system: SYSTEM_PROMPT,            // 见第四节
      taste: this.taste,
      routines: this.routines,
      environment: {
        time: now.toLocaleTimeString('zh-CN', { hour12: false }),
        weekday: ['周日','周一','周二','周三','周四','周五','周六'][now.getDay()],
        weather,
        agenda,
        device: trigger.device || 'unknown',
      },
      memory: {
        recentHistory: history,
        dislikedGenres: feedback,
      },
      input: trigger.raw,
      trace: trigger.lastTrace || null,
    };
  }

  // 组装为 Claude 输入的纯文本
  toPrompt(fragments) {
    return [
      `## 系统指令\n${fragments.system}`,
      `## 用户音乐品味\n${fragments.taste}`,
      `## 场景规则\n${fragments.routines}`,
      `## 当前环境\n${formatEnv(fragments.environment)}`,
      `## 近期播放\n${formatHistory(fragments.memory.recentHistory)}`,
      `## 用户输入\n${fragments.input}`,
      fragments.trace ? `## 上一轮执行\n${fragments.trace}` : '',
    ].filter(Boolean).join('\n\n---\n\n');
  }
}
```

### 2.4 Claude — 模型适配器 (`src/modules/claude.js`)

```js
// claude.js — 调用 Claude Code CLI，解析结构化输出

const { execSync } = require('child_process');

class Claude {
  async think(prompt) {
    const claudeInput = [
      prompt,
      '',
      '请以 JSON 格式回复（不要 markdown 包裹），格式：',
      JSON.stringify(RESPONSE_FORMAT, null, 2),
    ].join('\n');

    const start = Date.now();
    const output = execSync('claude -p --output json', {
      input: claudeInput,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    const latency = Date.now() - start;

    return this.parse(output, latency);
  }

  parse(raw, latency) {
    // 清理可能的 markdown 代码包裹
    const json = raw.replace(/```(json)?\n?/g, '').trim();

    try {
      const result = JSON.parse(json);
      return {
        say: String(result.say || ''),
        play: Array.isArray(result.play) ? result.play : [],
        reason: String(result.reason || ''),
        segue: String(result.segue || ''),
        _latency: latency,
        _raw: json,
      };
    } catch (e) {
      // 解析失败时降级：将全部输出作为 say 文本
      return {
        say: raw.trim(),
        play: [],
        reason: 'parse_failed',
        segue: '',
        _latency: latency,
        _raw: raw,
        _parseError: e.message,
      };
    }
  }

  // 简化版：仅生成 segue（歌曲间串场词，耗时短）
  async generateSegue(currentSong, nextSong) {
    const prompt = [
      `当前歌曲：${currentSong.title} - ${currentSong.artist}`,
      `下一首：${nextSong.title} - ${nextSong.artist}`,
      '生成 1-2 句简短有趣的过渡语，像是电台DJ在串场。只输出文本。',
    ].join('\n');

    const output = execSync('claude -p', {
      input: prompt, encoding: 'utf-8', timeout: 10_000,
    });
    return output.trim();
  }
}
```

### 2.5 Scheduler — 节律调度 (`src/modules/scheduler.js`)

```js
// scheduler.js — 基于 node-cron 的调度引擎

const cron = require('node-cron');

class Scheduler {
  constructor({ state, onTrigger }) {
    this.state = state;
    this.onTrigger = onTrigger;   // 回调函数 (trigger) => void
    this.tasks = [];
  }

  async start() {
    const rules = this.state.getEnabledRules();
    for (const rule of rules) {
      this.scheduleRule(rule);
    }
  }

  scheduleRule(rule) {
    const task = cron.schedule(rule.cron, async () => {
      console.log(`[Scheduler] 触发: ${rule.name} (${rule.scene})`);
      await this.onTrigger({
        type: 'scheduled',
        scene: rule.scene,
        config: rule.config ? JSON.parse(rule.config) : {},
      });
    });
    this.tasks.push({ rule, task });
  }

  stop() {
    this.tasks.forEach(t => t.task.stop());
  }
}

// —— 默认调度规则（首次启动时写入 State.db）——
const DEFAULT_RULES = [
  { name: '早间电台',     cron: '0 7 * * *',    scene: 'morning',     config: '{"duration":30}' },
  { name: '午间放松',     cron: '0 12 * * 1-5', scene: 'lunch',       config: '{"duration":20}' },
  { name: '通勤回家',     cron: '0 18 * * 1-5', scene: 'commute',     config: '{"duration":40}' },
  { name: '睡前淡出监测',  cron: '30 22 * * *',  scene: 'sleep_check', config: '{}' },
  { name: '情绪检查',     cron: '0 */2 * * *',  scene: 'mood_check',  config: '{}' },
  { name: '音乐发现',     cron: '0 20 * * 4',   scene: 'discovery',   config: '{}' },
];
```

### 2.6 TTS — 声音管线 (`src/modules/tts.js`)

```js
// tts.js — Fish Audio 异步合成 + 本地缓存

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

class TTS {
  constructor({ apiKey, cacheDir }) {
    this.apiKey = apiKey;
    this.cacheDir = path.resolve(cacheDir);
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  // 选择音色
  voiceForScene(scene) {
    const VOICE_MAP = {
      morning:   'female_energetic',   // 活力女声
      commute:   'neutral',             // 中性
      night:     'male_deep',           // 低沉男声
      focus:     'female_soft',         // 温柔轻声
      festival:  'female_joyful',       // 欢乐
      discovery: 'neutral',             // 中性
      default:   'neutral',
    };
    return VOICE_MAP[scene] || VOICE_MAP.default;
  }

  // 合成：返回本地缓存文件路径
  async synthesize(text, scene = 'default') {
    const hash = crypto.createHash('md5').update(text + scene).digest('hex');
    const filePath = path.join(this.cacheDir, `${hash}.mp3`);

    // 缓存命中
    if (fs.existsSync(filePath)) {
      return { filePath, cached: true };
    }

    // 调用 Fish Audio API
    const voice = this.voiceForScene(scene);
    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, voice, format: 'mp3' }),
    });

    if (!response.ok) throw new Error(`TTS API error: ${response.status}`);

    // 流式写入文件
    const writeStream = fs.createWriteStream(filePath);
    await pipeline(response.body, writeStream);

    return { filePath, cached: false };
  }
}
```

### 2.7 Music API 封装 (`packages/music-api/`)

```js
// song.js — 网易云音乐 API 封装

class NeteaseMusic {
  constructor(baseUrl = 'http://localhost:3000') {
    this.base = baseUrl;
  }

  // 搜索歌曲
  async search(keyword, limit = 10) {
    const res = await fetch(`${this.base}/search?keywords=${encodeURIComponent(keyword)}&limit=${limit}`);
    const data = await res.json();
    return data.result.songs.map(s => ({
      id: String(s.id),
      title: s.name,
      artist: s.artists.map(a => a.name).join(', '),
      album: s.album.name,
      duration: s.duration / 1000,
      cover: s.album.picUrl,
    }));
  }

  // 获取歌曲直链（有失效期，需在播放前获取）
  async getSongUrl(songId) {
    const res = await fetch(`${this.base}/song/url/v1?id=${songId}&level=standard`);
    const data = await res.json();
    return data.data[0]?.url || null;
  }

  // 获取歌词（含时间戳）
  async getLyric(songId) {
    const res = await fetch(`${this.base}/lyric?id=${songId}`);
    const data = await res.json();
    return {
      lrc: data.lrc?.lyric || '',
      tlyric: data.tlyric?.lyric || '',    // 翻译
    };
  }

  // 获取歌曲详情（含音频特征）
  async getSongDetail(songId) {
    const res = await fetch(`${this.base}/song/detail?ids=${songId}`);
    const data = await res.json();
    const song = data.songs[0];
    return {
      id: String(song.id),
      title: song.name,
      artist: song.ar.map(a => a.name).join(', '),
      album: song.al.name,
      duration: song.dt / 1000,
      cover: song.al.picUrl,
    };
  }
}
```

### 2.8 Executor — 指令执行器 (`src/modules/executor.js`)

```js
// executor.js — 接收 Claude 的结构化输出，执行具体操作

class Executor {
  constructor({ tts, music, state, ws }) {
    this.tts = tts;
    this.music = music;
    this.state = state;
    this.ws = ws;         // WebSocket 广播
  }

  async execute(claudeResponse, scene) {
    const { say, play, reason, segue } = claudeResponse;

    // 1. 解析播放队列，获取直链
    const songs = [];
    for (const item of play) {
      try {
        const url = await this.music.getSongUrl(item.id);
        const detail = await this.music.getSongDetail(item.id);
        const lyric = await this.music.getLyric(item.id);
        songs.push({ ...detail, url, lyric });
      } catch (err) {
        console.warn(`[Executor] 跳过歌曲 ${item.id}: ${err.message}`);
        continue;   // 单首失败不影响队列
      }
    }

    // 2. 合成播报
    let ttsFile = null;
    try {
      const ttsResult = await this.tts.synthesize(say, scene);
      ttsFile = ttsResult.filePath;
    } catch (err) {
      console.warn(`[Executor] TTS 合成失败: ${err.message}`);
      // 降级：前端显示文字字幕
    }

    // 3. WebSocket 推送
    this.ws.broadcast('song:change', {
      songs,
      ttsUrl: ttsFile ? `/tts/${path.basename(ttsFile)}` : null,
      sayText: say,
      segueText: segue,
    });

    // 4. 记录历史
    for (const song of songs) {
      this.state.addHistory({
        song_id: song.id,
        title: song.title,
        artist: song.artist,
        album: song.album,
        duration: song.duration,
        scene,
        reason,
      });
    }

    // 5. 保存计划
    this.state.savePlan({
      plan_date: new Date().toISOString().slice(0, 10),
      plan_time: new Date().toTimeString().slice(0, 5),
      scene,
      status: 'done',
      say_text: say,
      song_ids: JSON.stringify(songs.map(s => s.id)),
      reason,
    });

    return { songs, ttsFile };
  }
}
```

---

## 三、API 实现

### 3.1 HTTP 路由 (`src/api/http.js`)

```js
const express = require('express');

module.exports = function createApi({ state, executor, scheduler, router: intentRouter }) {
  const app = express.Router();
  app.use(express.json());

  // GET /api/now
  app.get('/now', (req, res) => {
    const current = state.getCurrentSession();
    res.json(current || { status: 'idle' });
  });

  // GET /api/queue
  app.get('/queue', (req, res) => {
    res.json(state.getQueue());
  });

  // POST /api/queue — 手动添加歌曲
  app.post('/queue', async (req, res) => {
    const { songId } = req.body;
    if (!songId) return res.status(400).json({ error: 'songId required' });
    const detail = await music.getSongDetail(songId);
    state.addToQueue(detail);
    ws.broadcast('queue:update', state.getQueue());
    res.json({ ok: true });
  });

  // GET /api/history
  app.get('/history', (req, res) => {
    const { limit = 50, offset = 0 } = req.query;
    res.json(state.getHistory({ limit: Number(limit), offset: Number(offset) }));
  });

  // GET /api/taste
  app.get('/taste', (req, res) => {
    const taste = fs.readFileSync(TastePath, 'utf-8');
    res.json({ taste });
  });

  // GET /api/plan/today
  app.get('/plan/today', (req, res) => {
    res.json(state.getTodaysPlans());
  });

  // POST /api/command — 用户指令入口
  app.post('/command', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const route = intentRouter.route(text);
    // ... 执行路由
    res.json({ ok: true, route });
  });

  // GET /api/devices
  app.get('/devices', (req, res) => {
    res.json(state.getAvailableDevices());
  });

  // POST /api/devices/switch
  app.post('/devices/switch', (req, res) => {
    const { deviceId } = req.body;
    state.setActiveDevice(deviceId);
    res.json({ ok: true });
  });

  return app;
};
```

### 3.2 WebSocket 实现 (`src/api/ws.js`)

```js
const { WebSocketServer } = require('ws');

class WsBroadcaster {
  constructor(server) {
    this.wss = new WebSocketServer({ server });
    this.clients = new Set();

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('message', (data) => this.handleMessage(ws, data));
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  handleMessage(ws, data) {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'user:command') {
        // 转发到 Router
        this.onUserCommand?.(msg.text);
      }
      // 客户端可订阅特定事件
      if (msg.type === 'subscribe') {
        ws.subscriptions = ws.subscriptions || new Set();
        ws.subscriptions.add(msg.event);
      }
    } catch { /* 忽略无效消息 */ }
  }

  broadcast(event, payload) {
    const message = JSON.stringify({ event, payload, timestamp: Date.now() });
    for (const client of this.clients) {
      if (client.readyState === 1) {  // OPEN
        // 如果客户端有订阅过滤，只推送订阅的事件
        if (client.subscriptions && !client.subscriptions.has(event)) continue;
        client.send(message);
      }
    }
  }
}
```

---

## 四、Prompt 工程

### 4.1 系统提示词 (SYSTEM_PROMPT)

```
你叫 Kimmelody，是一个有品位的 AI 音乐电台 DJ。
你的工作是根据用户的音乐品味、当前时间、天气、日程等信息，
规划播放列表并像真人电台主持人一样播报。

## 核心行为
1. 每次回复必须包含一段播报文案 (say) 和播放列表 (play)
2. 播报语气自然亲切，像朋友聊天，不是机器人
3. 根据场景调整语气：早间元气、晚间舒缓、通勤简洁
4. 每 3-5 首歌后，在 segue 字段补充一句歌曲冷知识或过渡语
5. 如果用户指令有歧义，主动询问确认

## 输出格式
输出 JSON，不要 markdown 包裹：

{
  "say": "播报文案（TTS 合成用）",
  "play": [
    { "id": "网易云歌曲ID", "title": "歌名", "artist": "歌手" }
  ],
  "reason": "选曲理由（供记录）",
  "segue": "歌曲间过渡语（可空）"
}

## 选曲规则
- 优先从用户 taste.md 中的偏好风格和歌手选择
- 避免用户明确不喜欢的风格/歌手
- 结合当前场景（时间/天气/日程）微调
- 歌单长度适配场景（通勤 30min ≈ 6-8 首）
- 歌曲顺序要有起伏：开场曲→主歌单→收尾曲

## 语音播报规则
- 不要过长，每次 30-80 字
- 包含场景信息（天气、时间、日程）自然融入
- 不用表情符号，不用括号标注动作
- 不说"下面为您播放""接下来请欣赏"这类套话
```

### 4.2 场景 Prompt 模版

Context 组装时根据场景在 system prompt 后追加：

```js
const SCENE_APPEND = {
  morning: `
## 早间电台模式
- 语气元气、积极，帮助用户开启一天
- 如果 9 点前有会议，提醒用户并选轻快但有精神的歌
- 歌单时长 20-30 分钟（通勤场景）
- 播报包含：天气、今日日程提醒（不超过 2 件事）
`,

  night: `
## 深夜模式
- 语气缓慢、轻柔
- 选曲偏向安静、氛围、纯音乐
- 播报简短，让音乐本身说话
- 如果超过 23:00，考虑引导用户休息
`,

  focus: `
## 专注模式
- 极简播报，只说 1-2 句
- 选曲以无人声/环境音乐为主
- 音量建议中低
`,

  discovery: `
## 音乐发现模式
- 选 2-3 首用户舒适区之外但有关联的歌
- 播报中说明推荐理由
- 观察用户反应（跳过/听完），后续调整策略
`,
};
```

### 4.3 输出解析容错

```js
// claude.js parse 方法的增强版本

parse(raw, latency) {
  const cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*$/gm, '')
    .replace(/^[\s\n]*{/, '{')   // 清除前置空白
    .trim();

  // 尝试提取第一个 JSON 对象
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return this.fallback(raw, latency, 'no_json_found');

  try {
    const result = JSON.parse(jsonMatch[0]);

    // 字段验证与默认值
    return {
      say: typeof result.say === 'string' ? result.say : '',
      play: Array.isArray(result.play) ? result.play.slice(0, 15) : [],  // 最多15首
      reason: typeof result.reason === 'string' ? result.reason : '',
      segue: typeof result.segue === 'string' ? result.segue : '',
      _latency: latency,
    };
  } catch (e) {
    return this.fallback(raw, latency, e.message);
  }
}

fallback(raw, latency, error) {
  return {
    say: raw.replace(/[{}"]/g, '').slice(0, 200),  // 直接输出文本
    play: [],
    reason: `parse_error: ${error}`,
    segue: '',
    _latency: latency,
    _error: error,
  };
}
```

---

## 五、前端架构 (`packages/web/`)

### 5.1 组件树

```
<App>
  ├── <NowPlayingBar>          — 底部固定，始终显示当前播放
  │   ├── <AlbumCover>          — 封面 + 旋转动画
  │   ├── <SongInfo>            — 标题 + 歌手
  │   ├── <ProgressBar>         — 进度条 + 时间
  │   └── <Controls>            — 播放/暂停/切歌/音量
  │
  ├── <MainContent>            — 路由切换
  │   ├── <NowPlayingPage>     — 主页：大封面 + 播报气泡 + 歌词
  │   │   ├── <BroadcastBubble>— AI 播报文字显示（打字机效果）
  │   │   └── <LyricsView>     — 逐行歌词同步高亮
  │   │
  │   ├── <QueuePage>          — 播放队列
  │   │   └── <QueueItem>      — 歌曲行 + 拖拽排序
  │   │
  │   ├── <TimelinePage>       — 今日电台节目表
  │   │   └── <TimelineCard>   — 时段卡片（已完成/进行中/待播）
  │   │
  │   ├── <HistoryPage>        — 播放历史
  │   │
  │   ├── <ProfilePage>        — 个人资料编辑
  │   │   ├── <TasteEditor>    — 编辑 taste.md（预览模式）
  │   │   └── <FeedbackList>   — 查看此前反馈
  │   │
  │   └── <SettingsPage>       — 设置
  │       ├── <VoiceSelector>  — TTS 音色选择
  │       ├── <DeviceList>     — 播放设备切换
  │       └── <ScheduleEditor> — 调度规则开关
  │
  └── <NavBar>                 — 底部导航
```

### 5.2 WebSocket 连接管理

```js
// src/hooks/useWebSocket.js

class WSClient {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.reconnectAttempts = 0;
    this.maxAttempts = 10;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onmessage = (event) => {
      const { event: type, payload } = JSON.parse(event.data);
      const handlers = this.listeners.get(type) || [];
      handlers.forEach(fn => fn(payload));
    };

    this.ws.onclose = () => {
      if (this.reconnectAttempts < this.maxAttempts) {
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
        setTimeout(() => this.connect(), delay);
        this.reconnectAttempts++;
      }
    };

    this.ws.onopen = () => { this.reconnectAttempts = 0; };
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  send(type, payload) {
    this.ws.send(JSON.stringify({ type, payload }));
  }
}
```

### 5.3 Service Worker 离线策略

```
核心资源（HTML/CSS/JS）—— Cache First，安装时预缓存
歌曲封面图片 ───────── Network First，缓存后备
TTS 音频 ──────────── Cache First（由 TTS 层保证 URL 与内容一一对应）
API 数据 ──────────── Network Only（保实时性）
```

---

## 六、配置系统

### 6.1 环境变量

```bash
# .env 文件（不提交 git，由 dotenv 加载）
PORT=8080
STATE_DB_PATH=./data/state.db
TASTE_PATH=./data/taste.md
ROUTINES_PATH=./data/routines.md
TTS_CACHE_DIR=./cache/tts
NETEASE_API_BASE=http://localhost:3000
FISH_AUDIO_API_KEY=xxx
OPENWEATHER_API_KEY=xxx
OPENWEATHER_CITY=Beijing
CALENDAR_TYPE=ical           # ical | feishu
CALENDAR_PATH=./data/calendar.ics
```

### 6.2 用户语料文件

**`data/taste.md`** — 自然语言描述音乐偏好：

```markdown
# 我的音乐品味

## 喜欢的风格（按优先级）
- Indie / Indie Rock / Folk
- 日系 City Pop
- 电子（Chillwave, Ambient）
- 爵士（Cool Jazz, Bossa Nova）

## 喜欢的歌手/乐队
- 房东的猫、陈鸿宇、草东没有派对
- 落日飞车、椅子乐团
- Tame Impala, Mac DeMarco

## 不喜欢的
- 重金属、硬核说唱
- 过于商业化的流行口水歌
- 悲伤到抑郁的歌（除非是深夜模式）

## 特殊偏好
- 喜欢有吉他前奏的歌
- 不喜欢频繁的高潮/副歌重复
- 对粤语歌无感
```

**`data/routines.md`** — 场景规则：

```markdown
# 日常场景规则

## 早间 (07:00 - 09:00)
- 工作日在通勤路上，需要 30 分钟左右的歌单
- 轻松、积极的 indie/folk，不要太激昂
- 周末可以睡懒觉，周末早间电台延后到 09:00

## 工作时间 (09:00 - 18:00)
- 有会议时不要自动播放
- 午休 (12:00-13:00) 可以放轻音乐
- 下午容易困，可以放些提神的

## 晚间 (18:00 - 22:00)
- 晚饭后适合放松，jazz / bossa nova
- 做家务时可以 upbeat 一些

## 深夜 (22:00 - )
- 安静、氛围、纯音乐
- 少说话
- 23:30 后如果没操作，自动 fade out
```

---

## 七、错误处理与容灾

### 7.1 模块级容灾矩阵

```
┌─────────────────┬──────────────────┬──────────────────┬──────────────────┐
│     模块         │ 失败场景          │ 容灾动作          │ 恢复策略          │
├─────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ NeteaseMusicApi │ 网络超时          │ 重试 1 次 → 跳过 │ 健康检查恢复后    │
│                 │ 歌曲直链失效       │ 换一首           │ 自动重试          │
├─────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ Fish Audio TTS  │ API 不可用        │ 文字降级          │ 每 5 分钟自动重试  │
│                 │ 合成超时           │ 静默跳过播报      │                   │
├─────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ Claude CLI      │ 超时 (30s)       │ 使用缓存计划      │ 下次调用恢复      │
│                 │ 输出解析失败       │ 文本直出          │                   │
├─────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ OpenWeather     │ API 不可用        │ 跳过天气注入      │ 定时重试          │
├─────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ 飞书日历         │ Token 过期        │ 跳过日程注入      │ 通知用户重新授权   │
├─────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ SQLite          │ 写入锁            │ 内存暂存 5s 后重试 │ WAL 模式减少锁    │
│                 │ 文件损坏           │ 从备份恢复        │                   │
└─────────────────┴──────────────────┴──────────────────┴──────────────────┘
```

### 7.2 健康检查端点

```js
// GET /api/health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    modules: {
      state:   checkState(),
      music:   await checkMusicAPI(),
      tts:     await checkTTS(),
      weather: await checkWeather(),
    },
    uptime: process.uptime(),
  });
});
```

---

## 八、性能优化

### 8.1 缓存策略

| 缓存对象 | 缓存位置 | TTL | 失效时机 |
| :--- | :--- | :--- | :--- |
| TTS 音频 | 磁盘 (cache/tts/) | 永久 | 文案变更 |
| 歌曲直链 | 内存 Map | 30 分钟 | 播放后即标记过期 |
| 歌词 | 内存 Map | 1 小时 | 歌曲切换 |
| 天气数据 | 内存 | 30 分钟 | 定时刷新 |
| Claude 响应 | 场景 hash → 磁盘 | 1 天 | 仅缓存纯定时场景 |

### 8.2 预加载机制

```js
// 下一首歌曲提前 10 秒预加载直链
class Preloader {
  constructor(music, state) {
    this.music = music;
    this.state = state;
  }

  onSongChange(currentIndex, queue) {
    const nextIndex = currentIndex + 1;
    if (nextIndex < queue.length) {
      const nextSong = queue[nextIndex];
      // 提前获取直链和歌词
      this.music.getSongUrl(nextSong.id).then(url => {
        this.state.setCachedUrl(nextSong.id, url);
      });
      this.music.getLyric(nextSong.id).then(lyric => {
        this.state.setCachedLyric(nextSong.id, lyric);
      });
    }
  }
}
```

### 8.3 启动时间优化

```
首次启动：
  1. 初始化 SQLite（~5ms）
  2. 读取语料文件（~2ms）
  3. 启动 HTTP/WS 服务（~50ms）
  4. 注册调度任务（~10ms）
  ─────────────────────
  总计：~70ms 到服务可用

  首次 Claude 调用额外 +3-8s（冷启动）
```

---

## 九、开发与测试

### 9.1 脚本命令

```json
{
  "scripts": {
    "dev": "node src/index.js",
    "start": "node src/index.js",
    "test": "jest",
    "test:watch": "jest --watch",
    "lint": "eslint src/",
    "bootstrap": "node scripts/bootstrap.js"
  }
}
```

### 9.2 测试策略

```
tests/
├── unit/                    # 单元测试
│   ├── router.test.js       # Router 正则匹配
│   ├── claude.test.js       # 输出解析容错
│   ├── context.test.js      # Prompt 组装
│   ├── scheduler.test.js    # Cron 规则解析
│   └── state.test.js        # SQLite CRUD
│
├── integration/             # 集成测试
│   ├── music-api.test.js    # 网易云 API 调用
│   └── tts.test.js          # TTS 合成 + 缓存
│
└── fixtures/                # 测试数据
    ├── taste.md
    ├── routines.md
    └── claude-response.json  # 模拟 Claude 输出
```

### 9.3 测试重点

```js
// router.test.js — 测试意图分流
describe('Router', () => {
  it('应将"下一首"匹配到 next_song', () => {
    expect(router.route('下一首').intent).toBe('next_song');
    expect(router.route('切歌').intent).toBe('next_song');
    expect(router.route('skip').intent).toBe('next_song');
  });

  it('应将"音量调到30"匹配到 volume_set 并解析数值', () => {
    const result = router.route('音量调到30');
    expect(result.intent).toBe('volume_set');
    expect(result.payload).toBe(30);
  });

  it('应将未知指令路由到 claude', () => {
    expect(router.route('来点周杰伦的歌').intent).toBe('claude');
  });
});

// claude.test.js — 测试输出解析容错
describe('Claude.parse', () => {
  it('应解析标准 JSON 输出', () => {
    const raw = JSON.stringify({ say: '你好', play: [{ id: '123', title: '歌', artist: '人' }] });
    const result = claude.parse(raw, 100);
    expect(result.say).toBe('你好');
    expect(result.play).toHaveLength(1);
  });

  it('应清理 markdown 代码块包裹', () => {
    const raw = '```json\n{"say": "hi"}\n```';
    expect(claude.parse(raw, 100).say).toBe('hi');
  });

  it('应在解析失败时降级为文本直出', () => {
    const raw = '你好，今天天气不错';
    const result = claude.parse(raw, 100);
    expect(result.say).toBeTruthy();
    expect(result.reason).toContain('parse_error');
  });
});
```

---

## 十、部署

### 10.1 本地开发启动

```bash
# 终端 1：网易云音乐 API
cd kimmelody/packages/music-api
npx NeteaseCloudMusicApi

# 终端 2：Kimmelody 服务
cd kimmelody/packages/server
cp .env.example .env    # 填写 API Key
npm run dev

# 终端 3：前端
cd kimmelody/packages/web
npm run dev
```

### 10.2 PM2 生产部署

```bash
# ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'kimmelody',
      script: 'src/index.js',
      cwd: './packages/server',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '200M',
      restart_delay: 5000,
      max_restarts: 10,
    },
    {
      name: 'music-api',
      script: 'node_modules/NeteaseCloudMusicApi/app.js',
      cwd: './packages/music-api',
      max_memory_restart: '150M',
    }
  ]
};
```

### 10.3 Docker（可选）

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 8080
CMD ["node", "packages/server/src/index.js"]
```

---

## 十一、增量路线图

| 阶段 | 里程碑 | 预估工时 | 可验证标准 |
| :--- | :--- | :--- | :--- |
| **P0** | 基础框架搭建 + State + 播放控制 | 2-3 天 | `POST /api/command "下一首"` 可工作 |
| **P1** | Claude 集成 + 早间电台场景 | 2-3 天 | 早 07:00 自动播放带播报的歌单 |
| **P2** | TTS + PWA 前端 | 2-3 天 | 完整的播放器界面 + 语音播报 |
| **P3** | 天气/日程接入 + 多场景 | 2 天 | 下雨天自动切换氛围歌单 |
| **P4** | 歌词同步 + Segue 生成 | 1-2 天 | 前端歌词滚动 + 歌曲间串场词 |
| **P5** | 创意功能（情绪/发现/睡前淡出等） | 3-4 天 | 连续跳过后的自动调整 |
| **P6** | UPnP 多设备 + 离线缓存 | 2-3 天 | 推送到家庭音响播放 |

---

## 十二、关键设计决策记录

| 决策 | 选项 | 选择 | 理由 |
| :--- | :--- | :--- | :--- |
| SQLite vs JSON 文件 | SQLite / JSON / LevelDB | SQLite | 查询灵活（按场景/时间过滤），WAL 模式读性能好 |
| 同步 vs 异步 SQLite | better-sqlite3 / sql.js | better-sqlite3 (sync) | SQLite 本地操作 <1ms，同步代码大幅简化错误处理 |
| Pompt 组装方式 | 字符串模板 / 模板引擎 / AST | 字符串模板 | Claude 需要纯文本输入，模板最直接 |
| TTS 缓存策略 | Hash key / 数据库索引 | Hash key (MD5) | O(1) 查找，无数据库依赖，文件名即 key |
| 前端框架 | React / Vue / Lit / Vanilla | Vanilla JS → Lit | 项目很小，框架 overhead 不值；后续可升级 Lit（< 5KB） |
| 多包管理 | npm workspaces / lerna / turborepo | npm workspaces | 内置支持，零配置，够用 |

---

*本文档与 need.md 同步维护。架构决策有变更时更新本文件。*
