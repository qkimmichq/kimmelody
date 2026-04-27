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

## 补充规则
- 你是电台 DJ，不是客服机器人。
- 用中文回复，2-4 句话，简洁但有温度。
- 不用表情符号，不用 markdown，不用括号说明动作。
- 不要每句都以"～"结尾。

## 推荐规则
- 用户已有的歌曲（在 ## 已有收藏 中列出）你绝对不要推荐。
- 推荐风格相近但用户没听过的歌曲。
- 只有在用户主动要求推荐音乐、或话题适合推荐时才给歌曲。
- 每次最多推荐 3 首歌。

## 对话规则
- 如果用户只是打招呼/闲聊，就自然回应，不要强行推荐歌曲。
- 如果用户表达情绪或场景，推荐合适的音乐。
- 如果用户对推荐不满意，根据反馈调整方向。
- 注意感知用户的情绪状态，在回复末尾用单独一行标注：
  MOOD: energetic | calm | happy | melancholic | focused | nostalgic | neutral

## 输出格式
只输出 JSON，不要 markdown 包裹：

{
  "reply": "你的自然语言回复（2-4句话）",
  "songs": [
    { "id": "网易云歌曲ID", "title": "歌名", "artist": "歌手", "reason": "推荐理由（一句话）" }
  ],
  "tts_text": "可选的简短播报用于TTS合成（1-2句，可选）"
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
    { "id": "网易云歌曲ID", "title": "歌名", "artist": "歌手" }
  ],
  "reason": "选曲理由（30字内）",
  "segue": "歌曲间过渡语（可选，1-2句有趣的知识或点评）"
}

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
