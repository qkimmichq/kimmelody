// 意图路由 —— 将用户输入分流到直连执行或 Claude 处理

const INTENT_RULES = [
  // ── 播放控制 ──
  { pattern: /^(播放|暂停|停一下|继续|pause|resume)$/i,   intent: 'toggle_play' },
  { pattern: /^(下一[首曲]|切歌|跳过|next|skip)$/i,        intent: 'next_song' },
  { pattern: /^上一[首曲]|prev$/i,                         intent: 'prev_song' },
  { pattern: /^音量\s*(调到?|设为?|改成?|to)?\s*(\d+)/i,   intent: 'volume_set', extract: (m) => Math.min(100, Math.max(0, parseInt(m[2]))) },
  { pattern: /^大[声点]|大声|vol(ume)?_up/i,                intent: 'volume_up' },
  { pattern: /^小[声点]|小声|vol(ume)?_down/i,              intent: 'volume_down' },
  { pattern: /^(静音|闭嘴|mute)$/i,                        intent: 'mute' },

  // ── 设备控制 ──
  { pattern: /^切(换)?(到)?\s*(音响|喇叭|音箱|蓝牙|speaker)/i, intent: 'switch_device', extract: () => 'speaker' },
  { pattern: /^切(换)?(到)?\s*耳机/i,                         intent: 'switch_device', extract: () => 'headphones' },
  { pattern: /^有(哪)?些设备|devices$/i,                      intent: 'list_devices' },

  // ── 信息查询 ──
  { pattern: /^现在(在)?放(的)?(什么|哪首)|what.*playing/i,    intent: 'now_playing' },
  { pattern: /^今[天日](的)?计划|today.?plan/i,                intent: 'today_plan' },
  { pattern: /^这[首个]什么歌|who.*sing/i,                     intent: 'current_song_info' },
];

export class Router {
  constructor(state) {
    this.state = state;
  }

  route(input) {
    const text = input.trim();
    if (!text) return { intent: 'none', raw: '' };

    // 1. 精确意图匹配
    for (const rule of INTENT_RULES) {
      const match = text.match(rule.pattern);
      if (match) {
        return {
          intent: rule.intent,
          payload: rule.extract ? rule.extract(match) : null,
          raw: text,
        };
      }
    }

    // 2. 上下文引用（"这个""那首"→ 回溯最近播放）
    if (/(这个|那个|这首|那首|刚才|刚刚|上一首)/.test(text)) {
      const recent = this.state.getHistory({ limit: 1 });
      return {
        intent: 'claude',
        payload: { referringSong: recent[0] || null },
        raw: text,
      };
    }

    // 3. 默认交予 Claude
    return { intent: 'claude', raw: text };
  }

  // 判断是否需要 Claude 处理
  needsClaude(intent) {
    return intent === 'claude';
  }
}
