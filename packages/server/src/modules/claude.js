import Anthropic from '@anthropic-ai/sdk';

const RESPONSE_FORMAT = {
  say: '播报文案',
  play: [{ id: '歌曲ID', title: '歌名', artist: '歌手' }],
  reason: '选曲理由',
  segue: '歌曲间过渡语（可选）',
};

const CHAT_RESPONSE_FORMAT = {
  reply: '你的自然语言回复（2-4句话）',
  songs: [{ id: '网易云歌曲ID', title: '歌名', artist: '歌手', reason: '推荐理由' }],
  tts_text: '可选的简短播报用于TTS合成（1-2句，可选）',
};

const SYSTEM_PROMPT = '你叫 Kimmelody，是一个有品位的 AI 音乐电台 DJ。你根据用户输入、场景信息、音乐品味来规划播放列表。只回复 JSON，不要 markdown 包裹。';

const CHAT_SYSTEM_PROMPT = '严格按照用户提示中的 DJ 人设进行回复。只输出 JSON，不要 markdown 包裹。';

const SEGUE_SYSTEM_PROMPT = '你是一个音乐电台 DJ。请为两首歌之间生成 1-2 句有趣的过渡语。自然、简短、像真人 DJ 说话。只输出过渡文本，不要任何标记。';

const STORY_SYSTEM_PROMPT = '你是 Kimmelody FM 的音乐电台 DJ。现在正在播放一首歌，请讲述一段关于这首歌或歌手的有趣小故事、冷知识或背景花絮（2-3句话）。语气温暖自然，让听众感到惊喜和亲切。只输出故事文本，不要任何标记。';

export class Claude {
  constructor({
    apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
    baseURL = process.env.ANTHROPIC_BASE_URL,
    model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6-20250514',
  } = {}) {
    if (!apiKey) throw new Error('ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required');

    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = model;
  }

  async think(prompt) {
    const fullPrompt = [
      prompt,
      '',
      '回复 JSON（不要 markdown 包裹）：',
      JSON.stringify(RESPONSE_FORMAT, null, 2),
    ].join('\n');

    const start = Date.now();
    try {
      const msg = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        temperature: 0.7,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: fullPrompt }],
      });

      const latency = Date.now() - start;
      const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
      const { input_tokens, output_tokens } = msg.usage || {};
      console.log(`[Claude] think: ${latency}ms, in:${input_tokens} out:${output_tokens}`);

      return this._parse(text, latency);
    } catch (err) {
      console.warn(`[Claude] think 调用失败:`, err.message);
      return this._fallback('抱歉，我现在有点卡顿，稍等一下再为你播报~', err.message);
    }
  }

  async generateSegue(currentSong, nextSong) {
    const prompt = [
      `当前歌曲：${currentSong.title} - ${currentSong.artist}`,
      `下一首：${nextSong.title} - ${nextSong.artist}`,
      '请为这两首歌之间生成 1-2 句有趣的过渡语。',
    ].join('\n');

    try {
      const msg = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        temperature: 0.8,
        system: SEGUE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
      return text.trim().slice(0, 200);
    } catch {
      return '';
    }
  }

  // 生成当前歌曲的趣味故事/冷知识（播放中自动触发）
  async generateSongStory(songTitle, songArtist) {
    const prompt = [
      `正在播放：《${songTitle}》 - ${songArtist}`,
      '请讲述一段关于这首歌或歌手的趣味小故事、冷知识或创作花絮。',
      '要求：2-3句话，自然温暖，像电台DJ在歌曲间隙给听众的小惊喜。',
      '不要重复歌名和歌手名。',
    ].join('\n');

    try {
      const msg = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        temperature: 0.85,
        system: STORY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
      return text.trim().slice(0, 300);
    } catch {
      return '';
    }
  }

  // Chat 流式对话方法（返回 async generator）
  async *thinkChatStream(prompt) {
    const fullPrompt = [
      prompt,
      '',
      '回复 JSON（不要 markdown 包裹）：',
      JSON.stringify(CHAT_RESPONSE_FORMAT, null, 2),
    ].join('\n');

    const start = Date.now();
    let fullText = '';

    try {
      const stream = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        temperature: 0.7,
        system: CHAT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: fullPrompt }],
        stream: true,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullText += event.delta.text;
          yield { type: 'text', text: event.delta.text };
        } else if (event.type === 'message_delta') {
          // usage info comes at the end
          const latency = Date.now() - start;
          const usage = event.usage;
          console.log(`[Claude] thinkChatStream: ${latency}ms, in:${usage?.input_tokens} out:${usage?.output_tokens}`);
        }
      }

      // Parse full response for structured data
      const parsed = this._parseChat(fullText, Date.now() - start);
      yield { type: 'done', reply: parsed.reply, songs: parsed.songs, tts_text: parsed.tts_text, mood: parsed.mood };

    } catch (err) {
      console.warn(`[Claude] thinkChatStream 调用失败:`, err.message);
      yield { type: 'error', message: '抱歉，我现在有点走神，能再说一遍吗？' };
    }
  }

  async thinkChat(prompt) {
    const fullPrompt = [
      prompt,
      '',
      '回复 JSON（不要 markdown 包裹）：',
      JSON.stringify(CHAT_RESPONSE_FORMAT, null, 2),
    ].join('\n');

    const start = Date.now();
    try {
      const msg = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        temperature: 0.7,
        system: CHAT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: fullPrompt }],
      });

      const latency = Date.now() - start;
      const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
      const { input_tokens, output_tokens } = msg.usage || {};
      console.log(`[Claude] thinkChat: ${latency}ms, in:${input_tokens} out:${output_tokens}`);

      return this._parseChat(text, latency);
    } catch (err) {
      console.warn(`[Claude] thinkChat 调用失败:`, err.message);
      return {
        reply: '抱歉，我现在有点走神，能再说一遍吗？',
        songs: [],
        tts_text: '',
        mood: 'neutral',
        _latency: 0,
      };
    }
  }

  _parseChat(raw, latency) {
    let cleaned = raw
      .replace(/```json\s*/gi, '')
      .replace(/```\s*$/gm, '')
      .replace(/^[\s\n]*\{/, '{')
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        reply: cleaned.slice(0, 200),
        songs: [],
        tts_text: '',
        mood: 'neutral',
        _latency: latency,
      };
    }

    try {
      const result = JSON.parse(jsonMatch[0]);
      let reply = typeof result.reply === 'string' ? result.reply.slice(0, 500) : '';

      let mood = 'neutral';
      const moodMatch = reply.match(/MOOD:\s*(\w+)/i);
      if (moodMatch) {
        mood = moodMatch[1].toLowerCase();
        reply = reply.replace(/MOOD:\s*\w+/i, '').trim();
      }

      return {
        reply,
        songs: Array.isArray(result.songs) ? result.songs.slice(0, 3).map(s => ({
          id: s.id || '',
          title: s.title || '',
          artist: s.artist || '',
          reason: s.reason || '',
        })) : [],
        tts_text: typeof result.tts_text === 'string' ? result.tts_text.slice(0, 200) : '',
        mood,
        _latency: latency,
      };
    } catch (e) {
      return {
        reply: cleaned.slice(0, 200),
        songs: [],
        tts_text: '',
        mood: 'neutral',
        _latency: latency,
      };
    }
  }

  _parse(raw, latency) {
    let cleaned = raw
      .replace(/```json\s*/gi, '')
      .replace(/```\s*$/gm, '')
      .replace(/^[\s\n]*\{/, '{')
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return this._fallback(cleaned.slice(0, 200), 'no_json_found');
    }

    try {
      const result = JSON.parse(jsonMatch[0]);
      return {
        say: typeof result.say === 'string' ? result.say.slice(0, 500) : '',
        play: Array.isArray(result.play) ? result.play.slice(0, 15) : [],
        reason: typeof result.reason === 'string' ? result.reason.slice(0, 200) : '',
        segue: typeof result.segue === 'string' ? result.segue.slice(0, 300) : '',
        _latency: latency,
      };
    } catch (e) {
      return this._fallback(cleaned.slice(0, 200), e.message);
    }
  }

  _fallback(text, error) {
    return {
      say: text,
      play: [],
      reason: `parse_error: ${error}`,
      segue: '',
      _latency: 0,
    };
  }
}
