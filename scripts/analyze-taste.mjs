// 从网易云音乐数据生成品味配置文件
// 运行: node scripts/analyze-taste.mjs

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
  // 读取 cookie
  let cookie = '';
  try { cookie = fs.readFileSync('data/netease_cookie.txt', 'utf-8').trim(); } catch {}
  if (!cookie) { console.log('❌ 未找到 cookie，请先运行 node scripts/login-netease.mjs'); return; }

  // 获取用户信息
  const status = await fetchApi('/login/status', cookie);
  if (!status.data?.profile) { console.log('❌ Cookie 已过期'); return; }

  const uid = status.data.profile.userId;
  console.log(`👤 ${status.data.profile.nickname} (${uid})`);

  // 1. 获取喜欢的音乐 ID 列表
  const liked = await fetchApi(`/likelist?uid=${uid}`, cookie);
  const likedIds = liked.ids || [];
  console.log(`❤️  喜欢的音乐: ${likedIds.length} 首`);

  // 2. 批量获取歌曲详情（API 支持逗号分隔）
  const batchSize = 50;
  const allSongs = [];
  for (let i = 0; i < Math.min(likedIds.length, 200); i += batchSize) {
    const batch = likedIds.slice(i, i + batchSize).join(',');
    const detail = await fetchApi(`/song/detail?ids=${batch}`, cookie);
    if (detail.songs) allSongs.push(...detail.songs);
    await new Promise(r => setTimeout(r, 300)); // 限速
  }
  console.log(`📦 获取了 ${allSongs.length} 首歌曲详情`);

  // 3. 统计歌手
  const artistPlayCount = {};
  for (const s of allSongs) {
    for (const ar of s.ar || []) {
      artistPlayCount[ar.name] = (artistPlayCount[ar.name] || 0) + 1;
    }
  }
  const topArtists = Object.entries(artistPlayCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  // 4. 获取歌单（含全部歌单内歌曲）
  const playlists = await fetchApi(`/user/playlist?uid=${uid}&limit=50`, cookie);
  console.log(`📋 歌单: ${playlists.playlist?.length || 0} 个`);

  // 提取歌单名中的关键词来推测风格
  const playlistNames = (playlists.playlist || []).map(p => p.name);
  const keywordMap = {
    '轻音乐': '轻音乐 / 纯音乐',
    '纯音乐': '轻音乐 / 纯音乐',
    '氛围': '氛围音乐 / Ambient',
    '伤感': '伤感流行',
    '爱情': '华语流行',
    '夕阳': '氛围音乐 / Chill',
    '晚霞': '氛围音乐 / Chill',
    '夏天': '夏日 / 流行',
    '日落': '氛围音乐 / Chill',
    'rap': '说唱 / Rap',
    '说唱': '说唱 / Rap',
    'R&B': 'R&B',
    '吉他': '吉他 / 弹唱',
    '火影': 'ACG / 动漫原声',
    'BGM': '影视原声 / 背景音乐',
    'EDM': '电子 / EDM',
    'DJ': '电子 / DJ舞曲',
  };
  const detectedKeywords = new Set();
  for (const name of playlistNames) {
    for (const [kw, genre] of Object.entries(keywordMap)) {
      if (name.includes(kw)) detectedKeywords.add(genre);
    }
  }

  // 5. 生成 taste.md
  const topArtistLines = topArtists.map(([name, count], i) =>
    `  ${i + 1}. ${name}（${count}首收藏）`
  ).join('\n');

  const favSongLines = allSongs.slice(0, 30).map(s =>
    `- ${s.name} — ${s.ar?.map(a => a.name).join('/') || '未知'}`
  ).join('\n');

  const genreLines = [...detectedKeywords].map(g => `- ${g}`).join('\n');
  const artistList = topArtists.slice(0, 20).map(([name]) => `- ${name}`).join('\n');

  const tasteContent = `# 我的音乐品味 — Kimmelody

> 自动分析自网易云音乐 (${status.data.profile.nickname}) — ${new Date().toLocaleString('zh-CN')}

## 高频歌手（按收藏数）
${topArtistLines}

## 收藏的歌曲风格关键词
${genreLines || '- 暂未分类'}

## 喜欢的歌手/乐队
${artistList}

## 收藏歌单
${playlistNames.slice(0, 10).map(n => `- ${n}`).join('\n')}

---

## ⭐ 收藏歌曲精选
${favSongLines}

---

*此文件自动生成，AI 电台在推荐音乐时会参考以上偏好。*
*如需手动调整，直接编辑此文件即可。*
`;

  fs.writeFileSync('data/taste.md', tasteContent);
  console.log('\n✅ taste.md 已更新！包含以下内容：');
  console.log(`   - ${topArtists.length} 位歌手`);
  console.log(`   - ${allSongs.length} 首收藏歌曲`);
  console.log(`   - ${detectedKeywords.size} 个风格标签`);
  console.log(`   - ${playlistNames.length} 个歌单`);

  // 打印摘要
  console.log('\n📊 偏好摘要:');
  console.log(`   最爱歌手: ${topArtists.slice(0, 5).map(([n]) => n).join('、')}`);
  console.log(`   风格标签: ${[...detectedKeywords].join('、') || '（分析中）'}`);
}

main().catch(err => console.error('失败:', err.message));
