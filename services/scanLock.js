const crypto = require("crypto");
const os = require("os");
const { openDatabase } = require("./database");

const db = openDatabase();
const ownerId = `${process.env.RENDER_INSTANCE_ID || os.hostname()}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
const configuredTtlMs = Number(process.env.PERPSIA_TELEGRAM_LOCK_TTL_MS);
const defaultTtlMs = Number.isFinite(configuredTtlMs) && configuredTtlMs >= 30000
  ? configuredTtlMs
  : 2 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS process_locks (
    name TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    acquired_at INTEGER NOT NULL
  )
`);

function lockResource(name, ttlMs = defaultTtlMs) {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO process_locks (name, owner_id, acquired_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      owner_id = excluded.owner_id,
      acquired_at = excluded.acquired_at
    WHERE process_locks.acquired_at < ?
  `).run(String(name), ownerId, now, now - ttlMs);
  return result.changes === 1;
}

function refreshResource(name) {
  const result = db.prepare("UPDATE process_locks SET acquired_at = ? WHERE name = ? AND owner_id = ?")
    .run(Date.now(), String(name), ownerId);
  return result.changes === 1;
}

function unlockResource(name) {
  db.prepare("DELETE FROM process_locks WHERE name = ? AND owner_id = ?")
    .run(String(name), ownerId);
}

function lockScan() {
  return lockResource("market_scan");
}

function unlockScan() {
  unlockResource("market_scan");
}

function lockTelegramPolling() {
  return lockResource("telegram_polling");
}

function refreshTelegramPollingLock() {
  return refreshResource("telegram_polling");
}

function unlockTelegramPolling() {
  unlockResource("telegram_polling");
}

module.exports = {
  lockScan,
  unlockScan,
  lockTelegramPolling,
  unlockTelegramPolling,
};
