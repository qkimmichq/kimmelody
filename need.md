# Kimmelody AI 音乐电台 Agent — 需求分析与设计文档

---

## 一、项目概述

**项目名称**：Kimmelody（原代号 Claudio）  
**定位**：个人专属 AI 音乐电台 Agent，通过理解用户听歌习惯、日程、天气等多维度信息，自动规划并播放适配场景的音乐，同时像真人 DJ 一样进行个性化语音播报，实现"懂你的全天候陪伴式音乐体验"。

**核心目标**：

- 用自然语言控制音乐播放，替代传统手动操作
- 基于用户数据自动生成个性化歌单与播报文案
- 打通多设备（手机 / 电脑 / 家庭音响）的无缝播放
- 低代码、本地优先的架构，确保数据隐私与可控性
- 像真正的电台 DJ 一样有温度、有知识、有情绪感知

---

## 二、系统架构（4 层结构）

```
┌─────────────────────────────────────────────────────┐
│  第四层：交互表层（PWA + API + WebSocket）             │
│  [Player] [Profile] [Settings] [Now Playing Bar]     │
├─────────────────────────────────────────────────────┤
│  第三层：运行时聚合层（Prompt 构建与执行引擎）            │
│  系统提示词 + 用户语料 + 环境注入 + 记忆 + 输入 + 轨迹   │
│  ──→ compute() ──→ {say, play[], reason, segue}      │
├─────────────────────────────────────────────────────┤
│  第二层：本地大脑层（业务逻辑）                          │
│  Router → Context → Claude → Scheduler/TTS/State     │
├─────────────────────────────────────────────────────┤
│  第一层：外部上下文层（数据输入）                         │
│  品味语料 | 音乐源API | 日程天气 | 设备 | 日历          │
└─────────────────────────────────────────────────────┘
```

---

## 三、项目目录结构

```
kimmelody/
│
├── packages/                        # 多包结构
│   ├── server/                      # Node.js 后端核心服务
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── router.js        # 意图分流
│   │   │   │   ├── context.js       # Prompt 组装
│   │   │   │   ├── claude.js        # Claude 交互适配器
│   │   │   │   ├── scheduler.js     # 节律调度引擎
│   │   │   │   ├── tts.js           # 声音管线
│   │   │   │   └── state.js         # 状态记忆（SQLite）
│   │   │   ├── api/
│   │   │   │   ├── http.js          # HTTP 路由
│   │   │   │   └── ws.js            # WebSocket 实时推送
│   │   │   └── index.js             # 入口
│   │   └── package.json
│   │
│   ├── web/                         # PWA 前端
│   │   ├── public/
│   │   │   ├── index.html
│   │   │   └── manifest.json
│   │   ├── src/
│   │   │   ├── components/          # 播放器、歌单卡片、播报气泡等
│   │   │   ├── pages/               # 主页面、个人资料、设置
│   │   │   ├── hooks/               # useWebSocket, usePlayer 等
│   │   │   ├── service/             # Service Worker（离线缓存）
│   │   │   └── index.js
│   │   └── package.json
│   │
│   └── music-api/                   # 网易云音乐 API 封装
│       ├── search.js
│       ├── song.js
│       ├── lyric.js
│       └── playlist.js
│
├── data/                            # 用户数据（本地优先，不提交 git）
│   ├── state.db                     # SQLite 数据库
│   ├── taste.md                     # 你的音乐品味描述
│   ├── routines.md                  # 日常作息与场景规则
│   ├── mod-rules.md                 # 修改规则
│   └── playlists.json               # 手动收藏/自定义歌单
│
├── cache/                           # 缓存文件
│   └── tts/                         # TTS 音频缓存 (hash.mp3)
│
├── scripts/                         # 工具脚本
│   ├── bootstrap.sh                 # 首次启动初始化
│   └── dev.sh                       # 开发模式一键启动
│
├── need.md                          # 本需求文档
└── package.json                     # workspace root
```

---

## 四、核心功能模块详细设计

### 4.1 第一层：外部上下文层（数据输入）

| 模块 | 功能描述 | 实现方式 |
| :--- | :--- | :--- |
| **用户品味语料** | 定义音乐偏好、禁忌风格、关键词。AI 据此理解"你喜欢什么" | `data/taste.md` 自然语言描述 + `data/routines.md` 场景规则 |
| **音乐源 API** | 网易云音乐搜索、直链、歌词、推荐 | `packages/music-api/` 封装，调用 NeteaseCloudMusicApi |
| **语音合成 API** | 播报文案转语音 | Fish Audio REST API，支持多音色 |
| **日程读取** | 读取日历事件，感知用户忙闲状态 | 飞书 API / iCal 本地文件 |
| **天气查询** | 获取实时天气，影响音乐氛围选择 | OpenWeatherMap API |
| **设备控制** | 推送音频到家庭音响 | UPnP / AirPlay 协议 |

### 4.2 第二层：本地大脑层（业务逻辑）

#### Router — 意图分流

```
用户输入 ──→ Router
              ├── 简单指令（"下一首""暂停"）──→ 直连播放控制
              ├── 音乐请求（"来点爵士"）──→ Context + Claude
              ├── 设备控制（"切换到音响"）──→ 设备模块直连
              └── 闲聊/提问（"这首歌谁唱的"）──→ Context + Claude
```

- 简单指令：基于关键词/正则匹配，零延迟响应
- 复杂请求：交予 Claude 理解意图并生成结构化指令
- 支持上下文消歧（例如 "这个" 指代当前播放的歌曲）

#### Context — Prompt 组装引擎

每次 AI 响应前，自动组装以下 6 部分内容：

1. **系统提示词**：定义 Agent 角色、规则、输出格式
2. **用户语料**：`taste.md` + `routines.md` 中的偏好和场景规则
3. **环境注入**：当前时间、天气、日程、设备状态
4. **已检索记忆**：近期播放历史、偏好变化、用户反馈
5. **用户输入 / 工具结果**：最新指令、API 返回的歌曲数据
6. **执行轨迹**：上一轮的执行记录（播放了什么、说了什么）

#### Claude — 大脑适配器

- 调用 `claude -p --output json`，传入完整 prompt
- 模型返回结构化 JSON，包含以下指令：

```json
{
  "say": "早上好！今天天气不错，给你选了首轻快的歌~",
  "play": [
    { "id": "song_123", "title": "起风了", "artist": "买辣椒也用券" },
    { "id": "song_456", "title": "理想三旬", "artist": "陈鸿宇" }
  ],
  "reason": "周一早晨通勤，用户偏好indie/folk，天气晴好",
  "segue": "接下来这首歌的吉他前奏是在浴室录的，很有趣的小故事"
}
```

- **say**: 播报文案（TTS 合成）
- **play[]**: 播放队列
- **reason**: 选曲理由（供记录和用户查阅）
- **segue**: 歌曲间串场词（DJ 式冷知识/点评）

#### Scheduler — 节律调度引擎

定时任务的规则引擎，支持：

| 触发方式 | 说明 | 示例 |
| :--- | :--- | :--- |
| 固定时段 | 每天固定时间唤醒 | 07:00 早间电台、18:00 通勤模式 |
| 日历挂钩 | 根据日程事件触发 | 会议前 10 分钟切换专注模式 |
| 情绪检查 | 定时评估是否需要调节氛围 | 每 2 小时检查一次 |
| 场景感知 | 结合天气、时间、日程综合判断 | 下雨天 + 无日程 = 慵懒模式 |
| 音乐发现 | 每周自动推荐舒适区外的新歌 | 每周四 20:00 "探索时刻" |

#### TTS — 声音管线

```
播报文案 → 检查缓存 (hash) → [未命中] Fish Audio API → 缓存 .mp3 → 推送播放
                               [命中]  直接返回缓存文件
```

- **场景化音色**：早间活力女声 / 深夜低沉男声 / 节日特殊音效 / 通勤中性声
- 缓存以文案 hash 为 key，避免重复合成
- 异步队列处理，不阻塞播放流程
- 失败回退：TTS 失败时以文字形式推送到前端

#### State — 状态记忆

基于 SQLite 的本地持久化，跨重启保持状态。详见第六节 Schema。

### 4.3 第三层：运行时聚合层

**核心执行流程**：

```
1. 输入收集 ──→ Router 分流
2. Prompt 组装 ──→ Context 合并 6 大片段
3. 模型推理 ──→ Claude 返回 {say, play[], reason, segue}
4. 歌单解析 ──→ music-api 获取直链
5. TTS 合成 ──→ Fish Audio → 缓存
6. 推送 ──→ WebSocket 发送播放信息到前端
7. 记录 ──→ State.db 写入历史
```

**执行频率**：

| 场景 | 触发 | 模型调用 | 延迟要求 |
| :--- | :--- | :--- | :--- |
| 固定电台（早/晚） | Scheduler | 每次 | < 30s |
| 用户指令 | Router | 每次 | < 5s |
| 情绪检查 | Scheduler (2h) | 每次 | < 60s |
| 歌曲间串场 | 每 3-5 首歌 | 仅生成 segue | < 3s |
| 音乐发现 | 每周一次 | 每次 | 不敏感 |

### 4.4 第四层：交互表层

#### PWA Web App

| 页面 | 功能 |
| :--- | :--- |
| **主页 (Now Playing)** | 当前歌曲封面、标题、歌手、进度条、播报气泡 |
| **播放器控件** | 播放/暂停、切歌、音量、进度拖动 |
| **播放队列** | 当前歌单列表，可手动调整顺序 |
| **今日计划** | 查看今日的电台节目安排 |
| **个人资料** | 编辑 taste.md / routines.md 的 GUI 界面 |
| **设置** | 音色切换、设备选择、开关模块 |

#### HTTP API

| 端点 | 方法 | 说明 |
| :--- | :--- | :--- |
| `GET /api/now` | - | 当前播放信息（歌曲、进度、播报） |
| `GET /api/queue` | - | 播放队列 |
| `POST /api/queue` | 添加歌曲 | 向队列追加歌曲 |
| `GET /api/history` | - | 播放历史（分页） |
| `GET /api/taste` | - | 当前用户偏好摘要 |
| `GET /api/plan/today` | - | 今日电台计划 |
| `GET /api/schedule` | - | 调度规则列表 |
| `POST /api/command` | 发送指令 | 文本指令入口（"下一首"等） |
| `GET /api/devices` | - | 可用播放设备列表 |
| `POST /api/devices/switch` | 切换设备 | 切换播放输出设备 |

#### WebSocket API (`WS /stream`)

| 事件 | 方向 | 说明 |
| :--- | :--- | :--- |
| `song:change` | 服务端推送 | 歌曲切换事件（含封面、歌词等） |
| `say:broadcast` | 服务端推送 | TTS 播报文本（前端可显示字幕） |
| `queue:update` | 服务端推送 | 队列变更事件 |
| `state:update` | 服务端推送 | 播放状态变化 |
| `lyric:sync` | 服务端推送 | 逐行歌词同步（含时间戳） |
| `user:command` | 客户端发送 | 用户指令 |

---

## 五、数据库 Schema (SQLite)

存储在 `data/state.db`：

### play_history — 播放历史

```sql
CREATE TABLE play_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id     TEXT NOT NULL,          -- 网易云歌曲 ID
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  album       TEXT,
  duration    INTEGER,                -- 歌曲时长（秒）
  played_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  scene       TEXT,                   -- 触发场景：morning/commute/relax/manual
  reason      TEXT,                   -- AI 选曲理由
  skipped     BOOLEAN DEFAULT 0,      -- 是否被跳过
  rating      INTEGER                 -- 用户反馈（1-5，可空）
);
```

### scheduled_plans — 电台计划

```sql
CREATE TABLE scheduled_plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date   DATE NOT NULL,
  plan_time   TIME NOT NULL,
  scene       TEXT NOT NULL,
  status      TEXT DEFAULT 'pending', -- pending/done/skipped/failed
  say_text    TEXT,                   -- AI 生成的播报文案
  song_ids    TEXT,                   -- JSON 数组
  reason      TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### user_feedback — 用户反馈

```sql
CREATE TABLE user_feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id     TEXT,
  feedback    TEXT NOT NULL,           -- 'like' / 'dislike' / 'love' / 'skip'
  context     TEXT,                    -- 反馈时的场景
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### tts_cache — TTS 缓存

```sql
CREATE TABLE tts_cache (
  hash        TEXT PRIMARY KEY,        -- 文案的 MD5/SHA256
  voice       TEXT NOT NULL,           -- 音色标识
  file_path   TEXT NOT NULL,           -- cache/tts/{hash}.mp3
  duration_ms INTEGER,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### playlists — 歌单

```sql
CREATE TABLE playlists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  song_ids    TEXT NOT NULL,           -- JSON 数组
  source      TEXT DEFAULT 'ai',       -- 'ai' AI生成 / 'manual' 手动
  scene       TEXT,                    -- 关联场景
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### schedule_rules — 调度规则

```sql
CREATE TABLE schedule_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  cron        TEXT NOT NULL,           -- cron 表达式
  scene       TEXT NOT NULL,           -- 触发场景
  enabled     BOOLEAN DEFAULT 1,
  config      TEXT,                    -- JSON 配置参数
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 六、创意功能设计

### 6.1 AI 音乐小百科 (Segue Facts)

歌曲切换时，Claude 生成 1-2 句关于歌曲/歌手/专辑的有趣冷知识，像真人 DJ 一样在播报中自然穿插。

- **触发时机**：每 3-5 首歌后 / 特殊歌曲（经典老歌、获奖作品）
- **数据来源**：Claude 自身知识 + 网易云评论/简介
- **呈现方式**：TTS 播报 + 前端字幕显示
- **示例**："接下来这首《山丘》是李宗盛花了 10 年才写完的词，据说第一版歌词是在洗手间马桶上写的。"

### 6.2 情绪感知播放

通过分析正在播放歌曲的声学特征（valence、energy、tempo）和用户交互模式（跳过、重播、收藏），感知用户当前情绪状态，自动微调选曲方向。

- **检测维度**：
  - 连续跳过 upbeat 歌曲 → 可能是烦躁，换舒缓
  - 反复重播某首歌 → 可能心情特别共鸣，推荐同类
  - 深夜 + 慢歌 + 无操作 → 可能快睡着了，开启淡出
- **实现方式**：Claude 分析播放历史模式 + 网易云音频特征 API

### 6.3 音乐发现模式（每周探索）

每周一次，AI 主动推荐 2-3 首用户舒适区之外但可能喜欢的歌。

- **策略**：基于用户现有偏好的边缘拓展（如喜欢 indie → 推荐 indie-rock / folk-pop）
- **触达方式**：播报中自然引入（"今天给你推荐一首不一样的..."）
- **用户反馈**：喜欢则纳入常规推荐池，不喜欢则调整方向

### 6.4 睡前淡出 (Sleep Fade)

深夜时段（22:00 后），检测到 15 分钟以上无用户交互，自动执行：

```
音量 -30% → 切换至氛围/纯音乐 → 每 5 分钟再降 20% → 停止播放
```

- 可配置开关和触发时间
- 可通过任何指令（"大声点""切歌"）立即唤醒正常模式

### 6.5 歌词同步推送

将网易云音乐歌词实时推送到前端，实现 KTV 式逐行高亮。

- 支持多语言翻译（中文歌词 → 英文翻译显示）
- WebSocket `lyric:sync` 事件带时间戳
- PWA 前端支持歌词滚动 + 高亮当前行

### 6.6 场景化 TTS 音色

不同场景自动切换 TTS 音色：

| 场景 | 音色风格 | 语气特征 |
| :--- | :--- | :--- |
| 早间电台 | 活力年轻女声 | 元气、清晰、语速偏快 |
| 通勤路上 | 中性自然声 | 简洁、信息密度高 |
| 深夜独处 | 低沉男声 | 缓慢、柔和、少说话多放歌 |
| 节日/生日 | 欢乐声特效 | 加入音效、语气夸张 |
| 工作专注 | 温柔轻声 | 极少说话，播报降到最低 |

### 6.7 多语言无缝混播

当歌单中混合中/英/日/韩语歌曲时，播报语言跟随歌曲语言自动切换。

- 中文歌 → 中文播报
- 英文歌 → 英文播报
- Claude 根据 context 中的 `next_song.lang` 字段决定播报语言

### 6.8 歌单导出分享

将 AI 生成的优质歌单导出为可分享格式。

- 支持格式：Markdown / JSON / 网易云歌单链接
- 包含：歌名、歌手、AI 推荐语（"适合下雨天听的歌"）
- 可一键复制或生成分享图片

---

## 七、核心用户场景示例

### 场景 1：早间通勤电台

1. **Scheduler 触发**：07:00 自动唤醒
2. **环境注入**：读取天气（晴）、日程（9 点有会）、设备（手机）
3. **Context 组装**：
   > 现在是周一早 7 点，天气晴，用户 9 点有会议，通勤 30 分钟，偏好轻松的 indie/folk 音乐，不要过于激昂。
4. **Claude 生成**：
   - 播报："早上好！周一快乐~今天天气不错，9 点有个会，路上先放松一下，帮你挑了几首轻快的歌，别迟到哦！"
   - 歌单：30 分钟 indie/folk
   - Segue："第一首歌来自房东的猫…据说这首歌的MV是在武汉拍的"
5. **执行**：TTS(活力女声) → music-api 获取直链 → WS 推送到手机

### 场景 2：用户即时指令

用户："放点爵士，不要太沉闷的那种"

1. **Router 解析**：音乐请求 → 爵士 + 明亮
2. **Context 组装**：加入偏好"爵士偏好：Miles Davis、王若琳，不要太 dark"
3. **Claude 返回**：3 首 upbeat jazz
4. **TTS**："爵士来啦！这几首都是轻快路线的，可以边喝咖啡边听~"
5. **执行**：播放 + 记录偏好"用户主动选 jazz/upbeat"

### 场景 3：自动情绪调节

系统检测到用户连续 3 首歌都切掉了（原本在播放摇滚）， 15:00 触发情绪检查。

1. **Scheduler** 触发情绪检查
2. **Context**：用户 15 分钟前跳过 3 首摇滚，可能有烦躁情绪；外面在下雨
3. **Claude 决策**：切换氛围音乐 + 减少播报频率
4. **TTS(轻柔声)**："感觉你有点烦躁，换点安静的音乐陪你~"
5. **播放**：缓拍电子 / 钢琴氛围

---

## 八、错误处理策略

| 错误场景 | 处理方式 |
| :--- | :--- |
| 网易云 API 超时 | 重试 1 次 → 失败则跳过该歌曲，选择下一首，记录日志 |
| 所有可用歌曲都获取失败 | 返回错误播报"音乐源暂时不可用，晚点再试试"，切换至本地音乐 |
| TTS 合成失败 | 静默重试 1 次 → 失败则前端显示文字字幕，跳过语音播报 |
| Claude 响应超时 | 使用上一轮缓存计划兜底，或播放默认场景歌单 |
| WebSocket 断连 | 前端自动重连（指数退避：1s → 2s → 4s → 30s max） |
| SQLite 写入失败 | 内存中暂存，5s 后重试，严重时重启服务 |
| 设备切换失败 | 回退到上一个可用设备，播报提示"音响连接失败，已切回本地播放" |

---

## 九、技术栈与约束

### 技术栈

| 层级 | 技术 | 说明 |
| :--- | :--- | :--- |
| 后端运行时 | **Node.js** (>=18) | 核心服务、调度、API 处理 |
| 大模型 | **Claude Code** | 本地 CLI 调用，无需额外 API Key |
| 音乐源 | **NeteaseCloudMusicApi** | 社区维护的网易云 API |
| 语音合成 | **Fish Audio API** | REST API，多音色 |
| 前端 | **PWA** (Vanilla JS / Lit) | 轻量 Web App，可离线 |
| 实时通信 | **WebSocket** (ws) | 双向实时推送 |
| 数据存储 | **SQLite** (better-sqlite3) | 本地持久化 |
| 设备发现 | **SSDP / UPnP** | 局域网音响设备发现 |
| 日程 | **iCal 文件 / 飞书 API** | 本地日历读取 |
| 天气 | **OpenWeatherMap API** | 实时天气 |

### 关键约束

- **本地优先**：核心逻辑在本地运行，仅调用必要的外部 API，不泄露用户数据
- **低耦合**：各模块（音乐、TTS、日程）独立，可按需替换
- **可扩展**：预留插件接口，支持更多音乐源、TTS 引擎、智能家居设备
- **可配置**：用户语料、调度规则、播报风格通过 `data/` 下文件修改，无需改代码
- **离线可用**：基础播放功能在网络不稳定时仍可工作（依赖本地缓存）

---

## 十、安装与运行

### 环境要求

- Node.js >= 18
- Claude Code CLI (已配置)
- 网易云音乐 API 服务（本地或远程）
- Fish Audio API Key

### 快速开始

```bash
# 1. 安装依赖
cd kimmelody && npm install

# 2. 配置用户语料
# 编辑 data/taste.md 和 data/routines.md

# 3. 启动网易云音乐 API 服务
cd packages/music-api && npm start

# 4. 启动 Kimmelody 服务
cd packages/server && npm run dev

# 5. 打开前端
# 浏览器访问 http://localhost:8080
```

### 配置环境变量

```bash
# .env (不提交 git)
OPENWEATHER_API_KEY=your_key
FISH_AUDIO_API_KEY=your_key
FEISHU_APP_ID=your_id    # 可选
NETEASE_API_BASE=http://localhost:3000
```

---

## 十一、验收标准

1. **基础播放控制**：能用自然语言指令播放、暂停、切歌、调节音量，延迟 < 2s
2. **个性化推荐**：能根据 taste.md + 场景自动推荐匹配度 > 80% 的歌单
3. **语音播报**：TTS 合成自然，不同场景使用不同音色，播报内容丰富（含 segues）
4. **定时电台**：早晚定时触发播放，读取天气和日程，播报内容上下文相关
5. **跨设备播放**：支持切换手机扬声器 / 电脑 / UPnP 音响
6. **持久化记忆**：重启后恢复上次播放位置、历史记录和偏好
7. **情绪感知**：检测连续跳过行为后自动调整选曲方向
8. **歌词同步**：前端显示逐行歌词，中英文支持
9. **音乐发现**：每周主动推荐新歌，支持用户反馈
10. **错误容灾**：任一 API 不可用时系统优雅降级，不崩溃

---

## 十二、未来展望

- **多用户支持**：同一实例服务多个家庭成员，各自独立的 taste profile
- **智能家居深度集成**：播放音乐时联动灯光（根据音乐氛围调色）、窗帘
- **音乐记忆地图**：记录每首歌播放时的地点/场景，生成"那年今日你在听什么"回顾
- **AI 对谈模式**：用户可直接与电台 AI 聊天（"这首歌的创作背景是什么？"）
- **播客/有声书模式**：扩展到播客订阅和有声书播放
- **本地音乐库支持**：接入本地 FLAC/WAV 文件，高保真播放
