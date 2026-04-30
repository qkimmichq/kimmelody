import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { WebSocket } from 'ws';

// ── 场景 → 语音映射 ──
const VOICE_MAP = {
  morning:   { fish: 'female_energetic', edge: 'zh-CN-XiaoxiaoNeural',   desc: '元气女声' },
  commute:   { fish: 'neutral',          edge: 'zh-CN-YunxiNeural',       desc: '沉稳男声' },
  night:     { fish: 'male_deep',        edge: 'zh-CN-XiaohanNeural',     desc: '温柔女声' },
  focus:     { fish: 'female_soft',      edge: 'zh-CN-XiaoxiaoNeural',    desc: '轻柔女声' },
  chat:      { fish: 'female_joyful',    edge: 'zh-CN-XiaoxiaoNeural',    desc: '女声' },
  festival:  { fish: 'female_joyful',    edge: 'zh-CN-XiaoxiaoNeural',    desc: '欢快女声' },
  discovery: { fish: 'neutral',          edge: 'zh-CN-YunxiNeural',       desc: '男声' },
  default:   { fish: 'neutral',          edge: 'zh-CN-XiaoxiaoNeural',    desc: '默认女声' },
};

// ═══════════════════════════════════════════
//  Edge TTS 后端（免费，无需 API Key）
// ═══════════════════════════════════════════

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;

function generateSecMsGecToken() {
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const roundedTicks = ticks - (ticks % 3000000000n);
  return createHash('sha256').update(`${roundedTicks}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function escapeXml(unsafe) {
  return unsafe.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return c;
    }
  });
}

class EdgeTTSBackend {
  voiceForScene(scene) {
    return VOICE_MAP[scene]?.edge || VOICE_MAP.default.edge;
  }

  _buildUrl() {
    const secGec = generateSecMsGecToken();
    return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secGec}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;
  }

  async synthesize(text, voice) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._buildUrl(), {
        host: 'speech.platform.bing.com',
        origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        headers: {
          'Pragma': 'no-cache',
          'Cache-Control': 'no-cache',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      const audioChunks = [];
      const wordBoundaries = [];
      const requestId = randomBytes(16).toString('hex');

      ws.on('open', () => {
        const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        })}`;

        ws.send(configMsg, { compress: true }, (err) => {
          if (err) { reject(err); return; }

          const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="${voice}"><prosody rate="default" pitch="default" volume="default">${escapeXml(text)}</prosody></voice></speak>`;

          const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;

          ws.send(ssmlMsg, { compress: true }, (err2) => {
            if (err2) reject(err2);
          });
        });
      });

      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          const text = data.toString('utf8');
          if (text.includes('turn.end')) {
            resolve({ audio: Buffer.concat(audioChunks), words: wordBoundaries });
            ws.close();
            return;
          }
          if (text.includes('Path:audio.metadata')) {
            const sepIdx = text.indexOf('\r\n\r\n');
            if (sepIdx !== -1) {
              try {
                const meta = JSON.parse(text.slice(sepIdx + 4));
                if (meta.Metadata) {
                  for (const m of meta.Metadata) {
                    const item = m.Data; // already parsed by JSON.parse, not a string
                    if (item && item.Offset != null && item.Duration != null) {
                      wordBoundaries.push({
                        word: item.text?.Text || item.text?.text || item.Word || '',
                        start: item.Offset / 10000000,
                        end: (item.Offset + item.Duration) / 10000000,
                      });
                    }
                  }
                }
              } catch { /* metadata parse error, skip */ }
            }
          }
          return;
        }

        const separator = 'Path:audio\r\n';
        const idx = data.indexOf(separator);
        if (idx !== -1) {
          audioChunks.push(data.subarray(idx + separator.length));
        }
      });

      ws.on('error', (err) => {
        reject(err);
      });

      ws.on('close', () => {
        if (audioChunks.length === 0) {
          reject(new Error('Edge TTS: no audio received'));
        }
      });

      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
        if (audioChunks.length === 0) reject(new Error('Edge TTS timeout'));
      }, 15000);
    });
  }
}

// ═══════════════════════════════════════════
//  Fish Audio 后端（原有，需 API Key）
// ═══════════════════════════════════════════

class FishAudioBackend {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  voiceForScene(scene) {
    return VOICE_MAP[scene]?.fish || VOICE_MAP.default.fish;
  }

  async synthesize(text, voice) {
    if (!this.apiKey) throw new Error('Fish Audio API key not configured');

    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, voice, format: 'mp3', speed: 1.0 }),
    });

    if (!response.ok) {
      throw new Error(`Fish Audio API error: ${response.status} ${response.statusText}`);
    }

    const chunks = [];
    for await (const chunk of response.body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

// ═══════════════════════════════════════════
//  自定义 TTS 后端（GPT-SoVITS / CosyVoice）
// ═══════════════════════════════════════════

class CustomTTSBackend {
  constructor(endpoint) {
    this.endpoint = endpoint;
  }

  voiceForScene(scene) {
    // CosyVoice uses scene names directly as voice names
    return scene in VOICE_MAP ? scene : 'default';
  }

  async synthesize(text, voice) {
    if (!this.endpoint) throw new Error('Custom TTS endpoint not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, format: 'mp3' }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Custom TTS error: ${response.status} ${response.statusText}`);
      }

      const chunks = [];
      for await (const chunk of response.body) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ═══════════════════════════════════════════
//  TTS 统一入口
// ═══════════════════════════════════════════

export class TTS {
  constructor({ apiKey, cacheDir = './cache/tts', state, customEndpoint } = {}) {
    this.cacheDir = resolve(cacheDir);
    this.state = state;
    console.log(`[TTS] 缓存目录: ${this.cacheDir}`);

    const fishKey = apiKey || process.env.FISH_AUDIO_API_KEY;
    const customUrl = customEndpoint || process.env.TTS_CUSTOM_ENDPOINT;

    // 后端优先级：custom > fish_audio > edge_tts
    if (customUrl) {
      this.backend = new CustomTTSBackend(customUrl);
      this.backendName = 'custom';
      console.log('[TTS] 使用自定义 TTS 后端:', customUrl);
    } else if (fishKey) {
      this.backend = new FishAudioBackend(fishKey);
      this.backendName = 'fish_audio';
      console.log('[TTS] 使用 Fish Audio 后端');
    } else {
      this.backend = new EdgeTTSBackend();
      this.backendName = 'edge_tts';
      console.log('[TTS] 使用 Edge TTS 免费后端（无 API Key 需要）');
    }

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  voiceForScene(scene) {
    return this.backend.voiceForScene(scene);
  }

  async synthesize(text, scene = 'default', { cache = true } = {}) {
    if (!text || !text.trim()) return null;

    const voice = this.voiceForScene(scene);
    const hash = createHash('md5').update(this.backendName + text + voice).digest('hex');
    const filePath = resolve(this.cacheDir, `${hash}.mp3`);
    const url = `/tts/${hash}.mp3`;

    if (cache) {
      if (existsSync(filePath)) {
        return { filePath, url, cached: true, words: [], text };
      }
      if (this.state) {
        const cached = this.state.getCachedTts(hash);
        if (cached && existsSync(cached.file_path)) {
          return { filePath: cached.file_path, url, cached: true, words: [], text };
        }
      }
    } else {
      // 不缓存时删除旧文件确保重新生成（chat/story等一次性的）
      try { if (existsSync(filePath)) { unlinkSync(filePath); } } catch {}
    }

    try {
      const result = await this.backend.synthesize(text, voice);
      const audioBuffer = Buffer.isBuffer(result) ? result : result.audio;
      const words = Buffer.isBuffer(result) ? [] : (result.words || []);

      writeFileSync(filePath, audioBuffer);

      if (this.state && cache) {
        this.state.saveTtsCache(hash, voice, filePath, null);
      }

      console.log(`[TTS] 合成完成: "${text.slice(0, 30)}..." (${this.backendName}, ${(audioBuffer.length / 1024).toFixed(1)}KB, ${words.length} words)`);
      return { filePath, url, cached: false, words, text };
    } catch (err) {
      console.warn(`[TTS] 合成失败 (${this.backendName}): ${err.message}`);
      return null;
    }
  }

  getCachedPath(hash) {
    const filePath = resolve(this.cacheDir, `${hash}.mp3`);
    return existsSync(filePath) ? filePath : null;
  }
}
