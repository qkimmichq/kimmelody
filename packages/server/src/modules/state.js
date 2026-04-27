import initSqlJs from 'sql.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS play_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id     TEXT NOT NULL,
    title       TEXT NOT NULL,
    artist      TEXT NOT NULL,
    album       TEXT,
    cover       TEXT,
    duration    INTEGER,
    played_at   DATETIME DEFAULT (datetime('now', 'localtime')),
    scene       TEXT,
    reason      TEXT,
    skipped     INTEGER DEFAULT 0,
    rating      INTEGER
  );

  CREATE TABLE IF NOT EXISTS scheduled_plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_date   TEXT NOT NULL,
    plan_time   TEXT NOT NULL,
    scene       TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',
    say_text    TEXT,
    song_ids    TEXT,
    reason      TEXT,
    created_at  DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS user_feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id     TEXT,
    feedback    TEXT NOT NULL,
    context     TEXT,
    created_at  DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS tts_cache (
    hash        TEXT PRIMARY KEY,
    voice       TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    duration_ms INTEGER,
    created_at  DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    song_ids    TEXT NOT NULL,
    source      TEXT DEFAULT 'ai',
    scene       TEXT,
    created_at  DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS schedule_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    cron        TEXT NOT NULL,
    scene       TEXT NOT NULL,
    enabled     INTEGER DEFAULT 1,
    config      TEXT,
    created_at  DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS playback_state (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
  );
`;

const DEFAULT_RULES = [
  { name: '早间电台',    cron: '0 7 * * 1-5',   scene: 'morning',   config: '{"duration":30}' },
  { name: '周末早间',    cron: '0 9 * * 0,6',   scene: 'morning',   config: '{"duration":30}' },
  { name: '午间放松',    cron: '0 12 * * 1-5',  scene: 'lunch',     config: '{"duration":20}' },
  { name: '通勤回家',    cron: '0 18 * * 1-5',  scene: 'commute',   config: '{"duration":40}' },
  { name: '睡前淡出',    cron: '30 22 * * *',   scene: 'sleep_check', config: '{}' },
  { name: '情绪检查',    cron: '0 */2 * * *',   scene: 'mood_check', config: '{}' },
  { name: '音乐发现',    cron: '0 20 * * 4',    scene: 'discovery', config: '{}' },
];

export class State {
  constructor(dbPath = './data/state.db') {
    this.dbPath = resolve(dbPath);
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = null;
    this.initialized = false;

    // 运行时状态（内存）
    this._currentSession = null;
    this._queue = [];
    this._activeDevice = 'local';
    this._cachedUrls = new Map();
    this._cachedLyrics = new Map();
    this._availableDevices = [{ id: 'local', name: '本机扬声器', type: 'local' }];
  }

  async init() {
    const SQL = await initSqlJs();

    // 从文件加载现有数据库，或创建新的
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run(SCHEMA);
    this._seedDefaults();
    this.initialized = true;
    return this;
  }

  _save() {
    // 将内存数据库写入文件
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
  }

  // helper: 将 sql.js exec 结果转为对象数组
  _queryAll(sql, params = {}) {
    // 简单参数替换（sql.js 的 prepare/bind 方式不同，这里用 exec 简化）
    let processedSql = sql;
    for (const [key, val] of Object.entries(params)) {
      const escaped = val === null ? 'NULL' : `'${String(val).replace(/'/g, "''")}'`;
      processedSql = processedSql.replace(`@${key}`, escaped);
    }
    try {
      const results = this.db.exec(processedSql);
      if (results.length === 0) return [];
      const { columns, values } = results[0];
      return values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
      });
    } catch (err) {
      console.error(`[State] Query error:`, err.message, '\nSQL:', processedSql);
      return [];
    }
  }

  _run(sql, params = {}) {
    let processedSql = sql;
    for (const [key, val] of Object.entries(params)) {
      const escaped = val === null ? 'NULL' : `'${String(val).replace(/'/g, "''")}'`;
      processedSql = processedSql.replace(`@${key}`, escaped);
    }
    try {
      this.db.run(processedSql);
      this._save();
    } catch (err) {
      console.error(`[State] Run error:`, err.message, '\nSQL:', processedSql);
    }
  }

  _seedDefaults() {
    const rows = this._queryAll('SELECT COUNT(*) as cnt FROM schedule_rules');
    if (rows.length === 0 || rows[0].cnt === 0) {
      for (const r of DEFAULT_RULES) {
        this._run(
          `INSERT INTO schedule_rules (name, cron, scene, enabled, config) VALUES (@name, @cron, @scene, 1, @config)`,
          r
        );
      }
    }
  }

  // ══════════════════════════════════════════
  //  Play History
  // ══════════════════════════════════════════

  addHistory(entry) {
    this._run(
      `INSERT INTO play_history (song_id, title, artist, album, cover, duration, scene, reason)
       VALUES (@song_id, @title, @artist, @album, @cover, @duration, @scene, @reason)`,
      entry
    );
  }

  getHistory({ limit = 50, offset = 0, scene } = {}) {
    let sql = 'SELECT * FROM play_history';
    const params = {};
    if (scene) { sql += ` WHERE scene = '${scene.replace(/'/g, "''")}'`; }
    sql += ' ORDER BY played_at DESC LIMIT ' + Number(limit) + ' OFFSET ' + Number(offset);
    return this._queryAll(sql);
  }

  getRecentSongs(hours = 24) {
    return this._queryAll(`
      SELECT * FROM play_history
      WHERE played_at >= datetime('now', 'localtime', '-${Number(hours)} hours')
      ORDER BY played_at DESC
    `);
  }

  getRecentScenes(limit = 5) {
    return this._queryAll(`
      SELECT DISTINCT scene, MAX(played_at) as last_at
      FROM play_history GROUP BY scene ORDER BY last_at DESC LIMIT ${Number(limit)}
    `);
  }

  // ══════════════════════════════════════════
  //  Discovery Helpers (for chat recommendations)
  // ══════════════════════════════════════════

  getAllKnownSongIds() {
    const rows = this._queryAll('SELECT DISTINCT song_id FROM play_history');
    return new Set(rows.map(r => String(r.song_id)));
  }

  getExistingSongEntries() {
    const rows = this._queryAll('SELECT DISTINCT title, artist FROM play_history WHERE title IS NOT NULL');
    return rows.map(r => ({ title: r.title, artist: r.artist }));
  }

  // ══════════════════════════════════════════
  //  User Feedback
  // ══════════════════════════════════════════

  addFeedback(songId, feedback, context) {
    this._run(
      `INSERT INTO user_feedback (song_id, feedback, context) VALUES (@song_id, @feedback, @context)`,
      { song_id: songId, feedback, context: context || '' }
    );
  }

  getDislikedGenres() {
    const rows = this._queryAll(`SELECT COUNT(*) as cnt FROM user_feedback WHERE feedback IN ('dislike', 'skip')`);
    return rows.length > 0 ? rows[0].cnt : 0;
  }

  // ══════════════════════════════════════════
  //  Scheduled Plans
  // ══════════════════════════════════════════

  savePlan(plan) {
    this._run(
      `INSERT INTO scheduled_plans (plan_date, plan_time, scene, status, say_text, song_ids, reason)
       VALUES (@plan_date, @plan_time, @scene, @status, @say_text, @song_ids, @reason)`,
      plan
    );
  }

  getTodaysPlans() {
    const today = new Date().toISOString().slice(0, 10);
    return this._queryAll(`SELECT * FROM scheduled_plans WHERE plan_date = '${today}' ORDER BY plan_time`);
  }

  updatePlanStatus(id, status) {
    this._run(`UPDATE scheduled_plans SET status = '${status.replace(/'/g, "''")}' WHERE id = ${Number(id)}`);
  }

  // ══════════════════════════════════════════
  //  TTS Cache
  // ══════════════════════════════════════════

  getCachedTts(hash) {
    const rows = this._queryAll(`SELECT * FROM tts_cache WHERE hash = '${hash.replace(/'/g, "''")}'`);
    return rows.length > 0 ? rows[0] : null;
  }

  saveTtsCache(hash, voice, filePath, durationMs) {
    this._run(
      `INSERT OR REPLACE INTO tts_cache (hash, voice, file_path, duration_ms)
       VALUES (@hash, @voice, @file_path, @duration_ms)`,
      { hash, voice, file_path: filePath, duration_ms: durationMs }
    );
  }

  // ══════════════════════════════════════════
  //  Schedule Rules
  // ══════════════════════════════════════════

  getEnabledRules() {
    return this._queryAll('SELECT * FROM schedule_rules WHERE enabled = 1');
  }

  updateRule(id, updates) {
    const sets = Object.entries(updates)
      .map(([k, v]) => `${k} = ${typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`}`)
      .join(', ');
    this._run(`UPDATE schedule_rules SET ${sets} WHERE id = ${Number(id)}`);
  }

  // ══════════════════════════════════════════
  //  Playlists
  // ══════════════════════════════════════════

  savePlaylist(playlist) {
    this._run(
      `INSERT INTO playlists (name, description, song_ids, source, scene)
       VALUES (@name, @description, @song_ids, @source, @scene)`,
      playlist
    );
  }

  getPlaylists(scene) {
    if (scene) {
      return this._queryAll(`SELECT * FROM playlists WHERE scene = '${scene.replace(/'/g, "''")}' ORDER BY created_at DESC`);
    }
    return this._queryAll('SELECT * FROM playlists ORDER BY created_at DESC');
  }

  // ══════════════════════════════════════════
  //  Runtime State (in-memory)
  // ══════════════════════════════════════════

  getCurrentSession() { return this._currentSession; }
  setCurrentSession(session) { this._currentSession = session; }

  getQueue() { return this._queue; }
  setQueue(queue) { this._queue = queue; }
  addToQueue(song) { this._queue.push(song); }
  clearQueue() { this._queue = []; }

  getActiveDevice() { return this._activeDevice; }
  setActiveDevice(id) { this._activeDevice = id; }

  getAvailableDevices() { return this._availableDevices; }
  addDevice(device) {
    if (!this._availableDevices.find(d => d.id === device.id)) {
      this._availableDevices.push(device);
    }
  }

  setCachedUrl(songId, url) { this._cachedUrls.set(songId, url); }
  getCachedUrl(songId) { return this._cachedUrls.get(songId); }

  setCachedLyric(songId, lyric) { this._cachedLyrics.set(songId, lyric); }
  getCachedLyric(songId) { return this._cachedLyrics.get(songId); }

  persistState(key, value) {
    const str = JSON.stringify(value);
    this._run(
      `INSERT OR REPLACE INTO playback_state (key, value) VALUES (@key, @value)`,
      { key, value: str }
    );
  }

  restoreState(key) {
    const rows = this._queryAll(`SELECT value FROM playback_state WHERE key = '${key.replace(/'/g, "''")}'`);
    if (rows.length === 0) return null;
    try { return JSON.parse(rows[0].value); } catch { return rows[0].value; }
  }

  close() {
    this.persistState('_queue', this._queue);
    this.persistState('_activeDevice', this._activeDevice);
    this._save();
    this.db.close();
  }
}
