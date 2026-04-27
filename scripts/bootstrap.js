/**
 * Kimmelody 首次启动初始化脚本
 * 创建必要的目录和默认配置
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const DIRS = [
  'data',
  'cache/tts',
  'packages/server/src/modules',
  'packages/server/src/api',
  'packages/web/public',
  'packages/music-api/src',
  'scripts',
];

const FILES = [
  { src: '.env.example', dst: '.env', optional: true },
];

console.log('╔══════════════════════════════════╗');
console.log('║   Kimmelody 初始化启动...         ║');
console.log('╚══════════════════════════════════╝');

// 1. 创建目录
for (const dir of DIRS) {
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true });
    console.log(`  📁 创建目录: ${dir}`);
  }
}

// 2. 复制配置
for (const f of FILES) {
  const src = resolve(ROOT, f.src);
  const dst = resolve(ROOT, f.dst);
  if (!existsSync(dst) && existsSync(src)) {
    copyFileSync(src, dst);
    console.log(`  📄 创建文件: ${f.dst}`);
  }
}

// 3. 检查依赖
console.log('\n  检查依赖...');
const { execSync } = await import('child_process');
try {
  execSync('npm --version', { encoding: 'utf-8', stdio: 'pipe' });
  console.log('  ✅ Node.js 已安装');
} catch {
  console.log('  ❌ 请先安装 Node.js (>=18)');
  process.exit(1);
}

try {
  execSync('claude --version', { encoding: 'utf-8', stdio: 'pipe' });
  console.log('  ✅ Claude Code 已安装');
} catch {
  console.log('  ⚠️  Claude Code 未安装。运行方式降级为 API 模式。');
}

// 4. 安装依赖
console.log('\n  安装 npm 依赖...');
execSync('npm install', { cwd: ROOT, stdio: 'inherit' });

console.log('\n╔══════════════════════════════════╗');
console.log('║   初始化完成!                     ║');
console.log('║                                  ║');
console.log('║   启动: npm run dev               ║');
console.log('║   访问: http://localhost:8080      ║');
console.log('╚══════════════════════════════════╝');
