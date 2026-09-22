const { openDatabase } = require("./database");

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_users (
    chat_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    blocked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS bot_user_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_bot_user_events_chat ON bot_user_events(chat_id, created_at);
`);

function trackUser(msg, eventType = "message", metadata = {}) {
  const chatId = String(msg?.chat?.id || msg?.from?.id || "");
  if (!chatId) return null;
  const user = msg?.from || msg?.chat?.user || {};
  db.prepare(`
    INSERT INTO bot_users (chat_id, username, first_name, status, last_seen_at, blocked_at)
    VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(chat_id) DO UPDATE SET
      username = COALESCE(excluded.username, bot_users.username),
      first_name = COALESCE(excluded.first_name, bot_users.first_name),
      status = 'active',
      last_seen_at = CURRENT_TIMESTAMP,
      blocked_at = NULL
  `).run(chatId, user.username || null, user.first_name || null);
  db.prepare("INSERT INTO bot_user_events (chat_id, event_type, metadata_json) VALUES (?, ?, ?)")
    .run(chatId, eventType, JSON.stringify(metadata || {}));
  return chatId;
}

function markUserStatus(chatId, status) {
  const normalized = status === "blocked" ? "blocked" : "active";
  db.prepare(`
    INSERT INTO bot_users (chat_id, status, last_seen_at, blocked_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CASE WHEN ? = 'blocked' THEN CURRENT_TIMESTAMP ELSE NULL END)
    ON CONFLICT(chat_id) DO UPDATE SET
      status = excluded.status,
      last_seen_at = CURRENT_TIMESTAMP,
      blocked_at = excluded.blocked_at
  `).run(String(chatId), normalized, normalized);
  db.prepare("INSERT INTO bot_user_events (chat_id, event_type) VALUES (?, ?)")
    .run(String(chatId), "user_" + normalized);
}

function isAdmin(chatId) {
  return String(process.env.PERPSIA_ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(String(chatId));
}

function getUserStats(chatId) {
  const rows = db.prepare("SELECT * FROM paper_positions WHERE chat_id = ? ORDER BY id DESC").all(String(chatId));
  const closed = rows.filter((row) => row.status === "CLOSED");
  const realized = closed.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0);
  const wins = closed.filter((row) => Number(row.realized_pnl) > 0).length;
  const losses = closed.filter((row) => Number(row.realized_pnl) < 0).length;
  return { open: rows.filter((row) => row.status === "OPEN").length, closed: closed.length, realized, wins, losses, winRate: closed.length ? (wins / closed.length) * 100 : 0 };
}

function getAdminStats() {
  const users = db.prepare("SELECT COUNT(*) AS count FROM bot_users").get().count;
  const active24h = db.prepare("SELECT COUNT(*) AS count FROM bot_users WHERE last_seen_at >= datetime('now', '-1 day') AND status = 'active'").get().count;
  const active7d = db.prepare("SELECT COUNT(*) AS count FROM bot_users WHERE last_seen_at >= datetime('now', '-7 days') AND status = 'active'").get().count;
  const blocked = db.prepare("SELECT COUNT(*) AS count FROM bot_users WHERE status = 'blocked'").get().count;
  const events = db.prepare("SELECT COUNT(*) AS count FROM bot_user_events WHERE created_at >= datetime('now', '-1 day')").get().count;
  return { users, active24h, active7d, blocked, events24h: events };
}

function getAdminUsers(limit = 50) {
  return db.prepare("SELECT chat_id, username, first_name, status, first_seen_at, last_seen_at, blocked_at FROM bot_users ORDER BY last_seen_at DESC LIMIT ?").all(Math.min(200, Math.max(1, Number(limit) || 50)));
}

function getLeaderboard(limit = 20) {
  const users = db.prepare("SELECT chat_id, username, first_name FROM bot_users WHERE status = 'active'").all();
  return users.map((user) => ({ user, stats: getUserStats(user.chat_id) }))
    .filter((row) => row.stats.closed > 0 || row.stats.open > 0)
    .sort((a, b) => b.stats.realized - a.stats.realized)
    .slice(0, Math.min(100, Math.max(1, Number(limit) || 20)));
}

module.exports = { getAdminStats, getAdminUsers, getLeaderboard, getUserStats, isAdmin, markUserStatus, trackUser };
