// 预加载器 — 提前获取下一首歌的直链和歌词

export class Preloader {
  constructor({ music, state }) {
    this.music = music;
    this.state = state;
  }

  onSongChange(currentIndex, queue) {
    // 预加载下一首
    const nextIdx = currentIndex + 1;
    if (nextIdx < queue.length) {
      const next = queue[nextIdx];
      if (!this.state.getCachedUrl(next.id)) {
        this.music.getSongUrl(next.id).then(url => {
          if (url) this.state.setCachedUrl(next.id, url);
        }).catch(() => {});
      }
      if (!this.state.getCachedLyric(next.id)) {
        this.music.getLyric(next.id).then(lyric => {
          this.state.setCachedLyric(next.id, lyric);
        }).catch(() => {});
      }
    }

    // 预加载下下首（更远的）
    const nextNextIdx = currentIndex + 2;
    if (nextNextIdx < queue.length) {
      const nextNext = queue[nextNextIdx];
      if (!this.state.getCachedUrl(nextNext.id)) {
        this.music.getSongUrl(nextNext.id).then(url => {
          if (url) this.state.setCachedUrl(nextNext.id, url);
        }).catch(() => {});
      }
    }
  }
}
