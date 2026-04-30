import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

import { State } from './modules/state.js';
import { TTS } from './modules/tts.js';
import { Router } from './modules/router.js';
import { ContextBuilder } from './modules/context.js';
import { Claude } from './modules/claude.js';
import { Executor } from './modules/executor.js';
import { Scheduler } from './modules/scheduler.js';
import { Preloader } from './modules/preloader.js';
import { NeteaseMusic } from '../../music-api/src/index.js';
import { WsBroadcaster } from './api/ws.js';
import { createHttpApi } from './api/http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ──
const PORT = process.env.PORT || 8080;
const STATE_DB_PATH = process.env.STATE_DB_PATH || path.resolve(__dirname, '../../data/state.db');
const TASTE_PATH = process.env.TASTE_PATH || path.resolve(__dirname, '../../data/taste.md');
const ROUTINES_PATH = process.env.ROUTINES_PATH || path.resolve(__dirname, '../../data/routines.md');
const DJ_PERSONA_PATH = process.env.DJ_PERSONA_PATH || path.resolve(__dirname, '../../data/dj-persona.md');
const TTS_CACHE_DIR = process.env.TTS_CACHE_DIR || path.resolve(process.cwd(), 'cache/tts');
const WEB_DIR = process.env.WEB_DIR || path.resolve(__dirname, '../../web/public');

async function main() {
  console.log('╔══════════════════════════════════╗');
  console.log('║   Kimmelody AI 音乐电台启动中...  ║');
  console.log('╚══════════════════════════════════╝');

  // 1. 初始化持久化层
  const state = new State(STATE_DB_PATH);
  await state.init();
  console.log('[Init] State 初始化完成');

  // 2. 初始化外部服务封装
  const music = new NeteaseMusic();
  const tts = new TTS({ cacheDir: TTS_CACHE_DIR, state });

  // 尝试加载登录凭证，否则匿名登录
  const cookieLoaded = await music.loadCookie(path.resolve(__dirname, '../../../data/netease_cookie.txt'));
  if (!cookieLoaded) {
    await music.login(); // 匿名登录
  }
  console.log('[Init] Music API + TTS 初始化完成');

  // 3. 初始化核心模块
  const router = new Router(state);
  const contextBuilder = new ContextBuilder({ state, tastePath: TASTE_PATH, routinesPath: ROUTINES_PATH, personaPath: DJ_PERSONA_PATH });
  const claude = new Claude();
  console.log('[Init] 大脑模块初始化完成');

  // 4. 初始化预加载器（需先有 music 和 state）
  const preloader = new Preloader({ music, state });

  // 5. 初始化 WebSocket + HTTP（WS 需要先创建，给 executor 用）
  const app = express();
  const server = http.createServer(app);
  const ws = new WsBroadcaster(server);
  console.log('[Init] WebSocket 初始化完成');

  // 6. 初始化执行器（依赖 ws）
  const executor = new Executor({ tts, music, state, ws, preloader });
  console.log('[Init] Executor 初始化完成');

  // 7. 初始化调度器，设置触发回调
  const scheduler = new Scheduler({
    state,
    onTrigger: async (trigger) => {
      console.log(`[Scheduler] 处理场景: ${trigger.scene}`);

      // 获取天气和日程（通过环境变量配置的简单实现）
      let weather = null;
      let agenda = null;
      try {
        if (process.env.OPENWEATHER_API_KEY) {
          const city = process.env.OPENWEATHER_CITY || 'Beijing';
          const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${process.env.OPENWEATHER_API_KEY}&lang=zh_cn`);
          const data = await res.json();
          if (data.weather?.[0]) {
            weather = `${data.weather[0].description}，${Math.round(data.main.temp - 273.15)}°C`;
          }
        }
      } catch (err) {
        console.warn('[Weather] 获取失败:', err.message);
      }

      try {
        const fragments = await contextBuilder.build(trigger, weather, agenda);
        const prompt = contextBuilder.toPrompt(fragments);
        const response = await claude.think(prompt);
        await executor.execute(response, trigger.scene);
      } catch (err) {
        console.error(`[Scheduler] 场景 ${trigger.scene} 执行失败:`, err.message);
      }
    },
  });

  // 恢复运行时状态
  try {
    const savedQueue = state.restoreState('_queue');
    if (savedQueue) state.setQueue(savedQueue);
    const savedDevice = state.restoreState('_activeDevice');
    if (savedDevice) state.setActiveDevice(savedDevice);
    console.log('[Init] 运行时状态已恢复');
  } catch {
    console.log('[Init] 无历史状态需要恢复');
  }

  // 8. 注册 HTTP API
  app.use(express.json());
  app.use('/api', createHttpApi({
    state, executor, scheduler, router, claude, contextBuilder, music, ws, tts,
  }));

  // 9. 静态文件服务
  app.use('/tts', express.static(TTS_CACHE_DIR));
  app.use(express.static(WEB_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/tts')) return next();
    res.sendFile(path.join(WEB_DIR, 'index.html'));
  });

  // 10. 启动
  scheduler.start();
  ws.onUserCommand = (text) => {
    console.log(`[WS] 收到指令: ${text}`);
    const route = router.route(text);
    if (!router.needsClaude(route.intent)) {
      // 简单指令直连执行
      switch (route.intent) {
        case 'toggle_play': executor.togglePlay(); break;
        case 'next_song': executor.nextSong(); break;
        case 'prev_song': executor.prevSong(); break;
        case 'volume_set': executor.setVolume(route.payload); break;
        case 'volume_up': executor.setVolume((state.restoreState('volume') || 80) + 10); break;
        case 'volume_down': executor.setVolume((state.restoreState('volume') || 80) - 10); break;
        default: break;
      }
    } else {
      // 复杂指令异步处理
      process.nextTick(async () => {
        try {
          const trigger = { ...route, device: state.getActiveDevice() };
          const fragments = await contextBuilder.build(trigger, null, null);
          const prompt = contextBuilder.toPrompt(fragments);
          const response = await claude.think(prompt);
          await executor.execute(response, 'manual');
        } catch (err) {
          console.error('[WS] Claude 处理失败:', err);
        }
      });
    }
  };

  server.listen(PORT, () => {
    console.log(`╔══════════════════════════════════╗`);
    console.log(`║   Kimmelody 已就绪!               ║`);
    console.log(`║   🌐 http://localhost:${PORT}      ║`);
    console.log(`║   📡 WS  : ws://localhost:${PORT}  ║`);
    console.log(`║   🎵 调度的任务: ${state.getEnabledRules().length} 个          ║`);
    console.log(`╚══════════════════════════════════╝`);
  });

  // 优雅关闭
  const shutdown = () => {
    console.log('\n[Shutdown] 正在关闭...');
    scheduler.stop();
    state.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
