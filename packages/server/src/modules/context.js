import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// 场景追加提示词
const SCENE_APPEND = {
  morning: `
## 场景：早间电台
- 语气元气、积极
- 如果 9 点前有会议，提醒用户并选轻快有精神的歌
- 歌单时长 20-30 分钟
- 播报包含：天气、今日日程（不超过 2 件事）`,

  lunch: `
## 场景：午间放松
- 选曲轻柔、放松
- 播报简短，不干扰用餐或休息`,

  commute: `
## 场景：通勤路上
- 选曲节奏明快但不激烈
- 播报简洁，关注路况和到家后安排`,

  night: `
## 场景：深夜模式
- 语气缓慢、轻柔
- 选曲偏向安静、氛围、纯音乐
- 播报简短，让音乐说话`,

  focus: `
## 场景：专注模式
- 极简播报，只说 1-2 句
- 选曲以无人声/环境音乐为主
- 音量建议中低`,

  discovery: `
## 场景：音乐发现
- 选 2-3 首用户舒适区之外但有关联的歌
- 播报中说明推荐理由
- 观察用户反馈`,

  sleep_check: `
## 场景：睡前检查
- 当前已过 22:30
- 如果用户长时间无操作，准备 fade out
- 选曲舒缓氛围，渐弱`,

  mood_check: `
## 场景：情绪检查
- 检查近期播放记录中是否有大量跳过行为
- 如果有，调整选曲方向，避免用户正在烦躁时放不对的歌`,
};

// ── Chat 系统提示词模板（含 DJ 人设注入） ──
function buildChatSystemPrompt(persona) {
  return `
${persona}

---

## 核心行为准则
- 你是电台 DJ Kimmelody，不是客服机器人。你要像真人 DJ 一样主动、热情、有温度地和听众交流。
- 用中文回复，自然流畅。可以是一句话，也可以是一段话——不要被字数限制。
- 主动延续对话：可以反问用户偏好、延展音乐话题、分享歌曲背后的故事或冷知识。
- 推荐歌曲时，一定要给出有温度的推荐理由：歌曲创作背景、歌手的趣事、年代风格特点、或者这首歌和你心情的关联。
- 不用表情符号，不用 markdown，不用括号说明动作。不要每句都以"～"结尾。

## 互动规则
- 如果用户只是打招呼或闲聊，先自然回应，再抛出一个开放性问题引导对话。
  例如："今天心情怎么样？想听点什么风格的音乐？" 或 "最近有在循环哪首歌吗？"
- 如果用户表达情绪或描述场景，先共情，再推荐合适氛围的音乐。
- 每首推荐歌曲都要附上推荐理由（1-2句），可以是：
  · 这首歌背后的创作故事
  · 歌手的有趣经历或时代背景
  · 这首歌的音乐风格特点和为什么适合现在听
- 如果用户对推荐不满意，根据反馈调整方向。
- 如果你不确定用户想听什么，主动问清楚风格、情绪、语种等偏好。

## 推荐规则
- 用户已有的歌曲（在 ## 已有收藏 中列出）你绝对不要推荐。
- 推荐风格相近但用户没听过的歌曲，帮助用户发现新音乐。
- 每次最多推荐 3 首歌。
- 歌曲信息中不需要提供 id 字段，系统会自动搜索匹配。只需提供歌名（title）和歌手（artist）。

## 对话规则
- 不要每轮回复都强行推荐歌曲。根据对话节奏自然决定。
- 如果对话本身在聊音乐话题（如歌手八卦、音乐史、风格讨论），可以顺势推荐。
- 注意感知用户的情绪状态，在回复末尾用单独一行标注：
  MOOD: energetic | calm | happy | melancholic | focused | nostalgic | neutral

## 输出格式
只输出 JSON，不要 markdown 包裹：

{
  "reply": "你的自然语言回复",
  "songs": [
    { "title": "歌名", "artist": "歌手", "reason": "推荐理由（含故事/趣事/背景，1-2句）" }
  ],
  "tts_text": "可选的简短播报用于TTS合成（可选）"
}

如果没有推荐歌曲，songs 字段返回空数组 []。
`;
}

// 系统提示词
const SYSTEM_PROMPT = `
你叫 Kimmelody，是一个有品位的 AI 音乐电台 DJ。
你的工作是根据用户的音乐品味、当前环境、播放历史等信息，
规划播放列表并像真人电台主持人一样播报。

## 输出格式
只输出 JSON，不要 markdown 包裹：

{
  "say": "播报文案（TTS 合成用，30-80字）",
  "play": [
    { "title": "歌名", "artist": "歌手" }
  ],
  "reason": "选曲理由（30字内）",
  "segue": "歌曲间过渡语（可选，1-2句有趣的知识或点评）"
}

歌曲信息中不需要提供 id 字段，系统会自动搜索匹配。只需提供准确的歌名（title）和歌手（artist）。

## 选曲规则
- 优先从用户 taste.md 中的偏好风格和歌手选择
- 避免用户明确不喜欢的风格/歌手
- 结合当前场景（时间/天气/日程）微调
- 歌单长度适配场景，通常 4-8 首
- 歌曲顺序要有起伏：开场→主歌单→收尾

## 播报规则
- 每次 30-80 字
- 自然亲切，像朋友聊天
- 将天气、日程等环境信息自然融入
- 不用表情符号，不用括号说明动作
- 不说"下面为您播放""接下来请欣赏"
- 深夜模式播报减少到 1-2 句
`;

export class ContextBuilder {
  constructor({ state, tastePath, routinesPath, personaPath } = {}) {
    this.state = state;
    this.tastePath = tastePath || resolve('./data/taste.md');
    this.routinesPath = routinesPath || resolve('./data/routines.md');
    this.personaPath = personaPath || resolve('./data/dj-persona.md');
  }

  _readFile(path) {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf-8').trim();
  }

  async build(trigger, weather, agenda) {
    const now = new Date();
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

    const history_10m = this.state.getRecentSongs(1); // 最近 1 小时

    return {
      system: SYSTEM_PROMPT,
      sceneAppend: SCENE_APPEND[trigger.scene] || '',
      taste: this._readFile(this.tastePath),
      routines: this._readFile(this.routinesPath),
      environment: {
        time: timeStr,
        weekday,
        weather: weather || '未知',
        agenda: agenda || '无日程',
        device: trigger.device || '本地',
      },
      memory: {
        recentHistory: history_10m.slice(0, 5),
      },
      input: trigger.raw || '',
      trace: trigger.lastTrace || null,
      scene: trigger.scene,
    };
  }

  toPrompt(fragments) {
    const parts = [
      `## 系统指令\n${fragments.system}`,
      fragments.sceneAppend,
      `## 用户音乐品味\n${fragments.taste || '（无特别指定）'}`,
      `## 场景规则\n${fragments.routines || '（无特别规则）'}`,
      `## 当前环境\n时间：${fragments.environment.weekday} ${fragments.environment.time}\n天气：${fragments.environment.weather}\n日程：${fragments.environment.agenda}\n设备：${fragments.environment.device}`,
    ];

    if (fragments.memory.recentHistory.length > 0) {
      const historyText = fragments.memory.recentHistory
        .map(s => `  ${s.title} - ${s.artist}（${s.scene || '手动'}）`)
        .join('\n');
      parts.push(`## 近期播放\n${historyText}`);
    }

    if (fragments.input) {
      parts.push(`## 用户输入\n${fragments.input}`);
    }

    if (fragments.trace) {
      parts.push(`## 上一轮执行\n${fragments.trace}`);
    }

    return parts.join('\n\n---\n\n');
  }

  // ── Chat 对话上下文 ──

  async buildChat(messages, { device, currentSong, recentHistory } = {}) {
    const now = new Date();
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

    const tasteRaw = this._readFile(this.tastePath);
    const persona = this._readFile(this.personaPath);
    const existingSongs = this._parseExistingSongs(tasteRaw);
    const recentPlayed = recentHistory || [];

    return {
      system: buildChatSystemPrompt(persona),
      taste: tasteRaw,
      routines: this._readFile(this.routinesPath),
      environment: {
        time: timeStr,
        weekday,
        device: device || '本地',
        currentPlaying: currentSong ? `${currentSong.title} - ${currentSong.artist}` : '无',
      },
      existingCollection: {
        songList: existingSongs,
        recentPlayed: recentPlayed.slice(0, 10).map(s => `${s.title} - ${s.artist}`),
      },
      conversation: messages,
    };
  }

  toChatPrompt(fragments) {
    const parts = [
      `## 系统指令\n${fragments.system}`,
      `## 用户音乐品味\n${fragments.taste || '（无特别指定）'}`,
      `## 场景规则\n${fragments.routines || '（无特别规则）'}`,
      `## 当前环境\n时间：${fragments.environment.weekday} ${fragments.environment.time}\n设备：${fragments.environment.device}\n正在播放：${fragments.environment.currentPlaying}`,
    ];

    // 已有收藏（黑名单）
    if (fragments.existingCollection.songList.length > 0) {
      parts.push(`## 已有收藏\n以下歌曲用户已经收藏或听过，不要推荐这些歌曲：\n${
        fragments.existingCollection.songList.map(s => `  ${s.title} - ${s.artist}`).join('\n')
      }`);
    }

    if (fragments.existingCollection.recentPlayed.length > 0) {
      parts.push(`## 近期已播放\n${
        fragments.existingCollection.recentPlayed.map(s => `  ${s}`).join('\n')
      }`);
    }

    // 对话历史
    if (fragments.conversation && fragments.conversation.length > 0) {
      const dialogParts = fragments.conversation.map(msg => {
        const role = msg.role === 'user' ? '用户' : 'Kimmelody';
        return `[${role}]\n${msg.content}`;
      });
      parts.push(`## 对话历史\n${dialogParts.join('\n\n')}`);
    }

    parts.push('[Kimmelody]\n');
    return parts.join('\n\n---\n\n');
  }

  _parseExistingSongs(tasteRaw) {
    if (!tasteRaw) return [];
    const songs = [];
    // 查找 "收藏歌曲精选" 部分
    const sectionMatch = tasteRaw.match(/##\s*[⭐*]*\s*收藏歌曲精选[\s\S]*?(?=---|$)/);
    if (!sectionMatch) return songs;

    const lines = sectionMatch[0].split('\n');
    for (const line of lines) {
      const cleaned = line.replace(/^[-*\d.\s]+/, '').trim();
      // 匹配 "歌名 - 歌手" 或 "歌名 — 歌手"
      const match = cleaned.match(/^(.+?)\s*[-—]\s*(.+)$/);
      if (match) {
        songs.push({ title: match[1].trim(), artist: match[2].trim() });
      }
    }
    return songs;
  }
}
