import { createHash } from 'crypto';
import { existsSync, mkdirSync, createWriteStream } from 'fs';
import { resolve, basename } from 'path';
import { pipeline } from 'stream/promises';

const VOICE_MAP = {
  morning:   'female_energetic',
  commute:   'neutral',
  night:     'male_deep',
  focus:     'female_soft',
  festival:  'female_joyful',
  discovery: 'neutral',
  default:   'neutral',
};

export class TTS {
  constructor({ apiKey, cacheDir = './cache/tts', state } = {}) {
    this.apiKey = apiKey || process.env.FISH_AUDIO_API_KEY;
    this.cacheDir = resolve(cacheDir);
    this.state = state;

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  voiceForScene(scene) {
    return VOICE_MAP[scene] || VOICE_MAP.default;
  }

  async synthesize(text, scene = 'default') {
    if (!text || !text.trim()) return null;

    const voice = this.voiceForScene(scene);
    const hash = createHash('md5').update(text + voice).digest('hex');
    const filePath = resolve(this.cacheDir, `${hash}.mp3`);

    // 缓存命中
    if (existsSync(filePath)) {
      return { filePath, url: `/tts/${hash}.mp3`, cached: true };
    }

    // 数据库缓存检查
    if (this.state) {
      const cached = this.state.getCachedTts(hash);
      if (cached && existsSync(cached.file_path)) {
        return { filePath: cached.file_path, url: `/tts/${hash}.mp3`, cached: true };
      }
    }

    // 调用 Fish Audio API
    if (!this.apiKey) {
      console.warn('[TTS] No API key configured, skipping TTS synthesis');
      return null;
    }

    try {
      const response = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          voice,
          format: 'mp3',
          speed: 1.0,
        }),
      });

      if (!response.ok) {
        throw new Error(`Fish Audio API error: ${response.status} ${response.statusText}`);
      }

      const writeStream = createWriteStream(filePath);
      await pipeline(response.body, writeStream);

      if (this.state) {
        this.state.saveTtsCache(hash, voice, filePath, null);
      }

      return { filePath, url: `/tts/${hash}.mp3`, cached: false };
    } catch (err) {
      console.warn(`[TTS] Synthesis failed: ${err.message}`);
      return null;
    }
  }

  // 获取缓存中的音频文件路径
  getCachedPath(hash) {
    const filePath = resolve(this.cacheDir, `${hash}.mp3`);
    return existsSync(filePath) ? filePath : null;
  }

  // 清理过期缓存（保留最近 200 个）
  async cleanCache(keep = 200) {
    if (!existsSync(this.cacheDir)) return;
    const { readdir, unlink } = await import('fs/promises');
    const files = (await readdir(this.cacheDir))
      .filter(f => f.endsWith('.mp3'))
      .map(f => ({ name: f, path: resolve(this.cacheDir, f), mtime: 0 }));
    // 简化：实际可用 stat 获取 mtime
    if (files.length > keep) {
      // 删除多余文件逻辑
    }
  }
}
