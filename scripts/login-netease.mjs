// 网易云音乐 — 登录后获取用户数据（带 cookie）
// 运行: node scripts/login-netease.mjs

const API = 'http://localhost:3000';
const fs = await import('fs');

async function fetchApi(path, cookie) {
  const opts = {};
  if (cookie) opts.headers = { Cookie: cookie };
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  // 1. 检查是否已有 cookie
  let cookie = '';
  try {
    cookie = fs.readFileSync('data/netease_cookie.txt', 'utf-8').trim();
    console.log('📂 找到已保存的 cookie');
  } catch {
    console.log('🆕 需要重新登录');
  }

  // 2. 如果有 cookie，检查是否有效
  if (cookie) {
    const status = await fetchApi('/login/status', cookie);
    if (status.data?.profile) {
      console.log(`✅ Cookie 有效，用户: ${status.data.profile.nickname}`);
      await fetchUserData(cookie, status.data.profile);
      return;
    } else {
      console.log('⚠️  Cookie 已过期，重新登录');
      cookie = '';
    }
  }

  // 3. 无有效 cookie → QR 登录
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║    网易云音乐 — QR 扫码登录              ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const keyData = await fetchApi(`/login/qr/key?ts=${Date.now()}`);
  const key = keyData.data.unikey;
  console.log(`[1/3] QR Key: ${key}`);

  const qrData = await fetchApi(`/login/qr/create?key=${key}&qrimg=true&ts=${Date.now()}`);
  const base64Data = qrData.data.qrimg.includes('base64,') ? qrData.data.qrimg.split('base64,')[1] : qrData.data.qrimg;
  fs.writeFileSync('cache/netease_qr.png', Buffer.from(base64Data, 'base64'));
  console.log('[2/3] 二维码已保存到 cache/netease_qr.png');
  console.log('   👆 请打开该图片，用网易云音乐 App 扫码\n');

  console.log('[3/3] 等待扫码...');
  for (let i = 0; i < 60; i++) {
    const check = await fetchApi(`/login/qr/check?key=${key}&ts=${Date.now()}`);
    const code = check.code || check.data?.code;

    if (code === 803) {
      console.log('   ✅ 扫码成功！');
      // 提取 MUSIC_U cookie
      const rawCookie = check.cookie || '';
      const musicU = rawCookie.split(';').find(c => c.trim().startsWith('MUSIC_U='));
      cookie = musicU || rawCookie;
      fs.writeFileSync('data/netease_cookie.txt', cookie);
      console.log('   💾 Cookie 已保存\n');

      // 获取用户信息
      const status = await fetchApi('/login/status', cookie);
      if (status.data?.profile) {
        await fetchUserData(cookie, status.data.profile);
      }
      return;
    } else if (code === 800) {
      console.log('❌ 二维码已过期，请重新运行');
      return;
    } else if (code === 802) {
      console.log('📱 已扫码，请在手机上确认...');
    } else {
      process.stdout.write('.');
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\n❌ 扫码超时');
}

async function fetchUserData(cookie, profile) {
  console.log(`👤 用户: ${profile.nickname} (${profile.userId})`);
  const uid = profile.userId;

  // 1. 听歌排行
  console.log('\n═══════════ 听歌排行（全部） ═══════════\n');
  const records = await fetchApi(`/user/record?uid=${uid}&type=1`, cookie);
  const topSongs = [];
  if (records.allData) {
    for (const rec of records.allData.slice(0, 30)) {
      const s = rec.song;
      const name = s.name;
      const artist = s.ar?.map(a => a.name).join(', ') || '';
      topSongs.push({ name, artist, score: rec.score });
      console.log(`  ${String(rec.score).padStart(4)}次  ${name} - ${artist}`);
    }
  }

  // 2. 获取歌单
  console.log('\n═══════════ 歌单 ═══════════\n');
  const playlists = await fetchApi(`/user/playlist?uid=${uid}&limit=30`, cookie);
  if (playlists.playlist) {
    for (const pl of playlists.playlist) {
      console.log(`  📋 ${pl.name} (${pl.trackCount}首)`);
    }
  }

  // 3. 获取喜欢的音乐
  console.log('\n═══════════ 喜欢的音乐（最新10首） ═══════════\n');
  const liked = await fetchApi(`/likelist?uid=${uid}`, cookie);
  if (liked.ids?.length > 0) {
    const batchIds = liked.ids.slice(0, 10).join(',');
    const details = await fetchApi(`/song/detail?ids=${batchIds}`, cookie);
    if (details.songs) {
      for (const s of details.songs) {
        console.log(`  ❤️  ${s.name} - ${s.ar?.map(a => a.name).join(',') || '?'}`);
      }
    }
  }

  // 4. 分析偏好并更新 taste.md
  console.log('\n═══════════ 偏好分析 ═══════════\n');

  // 统计 top 歌手
  const artistCount = {};
  for (const rec of records.allData || []) {
    const s = rec.song;
    for (const ar of s.ar || []) {
      artistCount[ar.name] = (artistCount[ar.name] || 0) + rec.score;
    }
  }
  const sortedArtists = Object.entries(artistCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  console.log('最爱歌手 TOP 15:');
  sortedArtists.forEach(([name, score], i) => {
    console.log(`  ${i+1}. ${name} (${score}次播放)`);
  });

  // 统计 tag/风格
  const tagCount = {};
  for (const rec of records.allData || []) {
    const s = rec.song;
    for (const tag of s.artists?.[0]?.tags || []) {
      tagCount[tag] = (tagCount[tag] || 0) + 1;
    }
  }

  // 生成 taste.md
  const topArtistNames = sortedArtists.map(([name]) => name);
  const tasteContent = `# 我的音乐品味 — Kimmelody（自动分析自网易云音乐）

> 此文件由 AI 根据网易云音乐听歌记录自动生成。
> 最后更新: ${new Date().toLocaleString('zh-CN')}

## 🎵 最常听的歌手（Top 15）
${sortedArtists.map(([name], i) => `- ${name}`).join('\n')}

## ⭐ 高频播放歌曲
${topSongs.slice(0, 20).map(s => `- ${s.name} — ${s.artist}`).join('\n')}

## 🤖 AI 分析说明
以上数据来自你的网易云音乐听歌排行和收藏。
Kimmelody AI 会结合这些信息 + time.md 中的场景规则，
在每次播放时为你推荐合适的音乐。
`;

  fs.writeFileSync('data/taste.md', tasteContent);
  console.log('\n✅ taste.md 已更新！');
  console.log('\n🎉 登录和数据获取完成！Kimmelody 现在可以基于你的真实听歌数据做推荐了。\n');
}

main().catch(err => {
  console.error('失败:', err.message);
  process.exit(1);
});
