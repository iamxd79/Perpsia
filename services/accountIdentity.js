"use strict";

const crypto = require("crypto");
const { openDatabase } = require("./database");

const db = openDatabase();
const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_APP_URL = "https://www.perpsia.app";

db.exec(`
  CREATE TABLE IF NOT EXISTS perpsia_accounts (
    account_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS perpsia_identities (
    identity_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, subject),
    FOREIGN KEY(account_id) REFERENCES perpsia_accounts(account_id)
  );

  CREATE TABLE IF NOT EXISTS telegram_link_sessions (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL,
    telegram_subject TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(account_id) REFERENCES perpsia_accounts(account_id)
  );

  CREATE INDEX IF NOT EXISTS idx_perpsia_identities_account
    ON perpsia_identities(account_id);
  CREATE INDEX IF NOT EXISTS idx_telegram_link_sessions_expiry
    ON telegram_link_sessions(expires_at, consumed_at);
`);

function normalizeProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_:-]{1,63}$/.test(value)) {
    throw new Error("A valid identity provider is required.");
  }
  return value;
}

function normalizeSubject(subject) {
  const value = String(subject ?? "").trim();
  if (!value || value.length > 255) throw new Error("A valid identity subject is required.");
  return value;
}

function parseMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata;
}

function readIdentity(row) {
  if (!row) return null;
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json || "{}");
  } catch {
    metadata = {};
  }
  return { ...row, metadata };
}

function getIdentity(provider, subject) {
  const row = db.prepare(`
    SELECT identity_id, account_id, provider, subject, metadata_json, created_at, last_seen_at
    FROM perpsia_identities
    WHERE provider = ? AND subject = ?
  `).get(normalizeProvider(provider), normalizeSubject(subject));
  return readIdentity(row);
}

function getOrCreateIdentity(provider, subject, metadata = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSubject = normalizeSubject(subject);
  const safeMetadata = parseMetadata(metadata);
  const existing = getIdentity(normalizedProvider, normalizedSubject);
  if (existing) {
    db.prepare(`
      UPDATE perpsia_identities
      SET metadata_json = ?, last_seen_at = CURRENT_TIMESTAMP
      WHERE identity_id = ?
    `).run(JSON.stringify(safeMetadata), existing.identity_id);
    return { ...existing, metadata: safeMetadata, last_seen_at: new Date().toISOString() };
  }

  const accountId = crypto.randomUUID();
  const create = db.transaction(() => {
    db.prepare("INSERT INTO perpsia_accounts (account_id) VALUES (?)").run(accountId);
    db.prepare(`
      INSERT INTO perpsia_identities (account_id, provider, subject, metadata_json)
      VALUES (?, ?, ?, ?)
    `).run(accountId, normalizedProvider, normalizedSubject, JSON.stringify(safeMetadata));
  });
  create();
  return getIdentity(normalizedProvider, normalizedSubject);
}

function getOrCreateTelegramAccount(chatId, metadata = {}) {
  return getOrCreateIdentity("telegram", String(chatId), metadata);
}

function hashLinkToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createTelegramLinkSession(chatId, options = {}) {
  const identity = getOrCreateTelegramAccount(chatId, options.metadata || {});
  const token = crypto.randomBytes(32).toString("base64url");
  const ttlMs = Math.min(
    Math.max(Number(options.ttlMs) || DEFAULT_LINK_TTL_MS, 1000),
    30 * 60 * 1000,
  );
  const expiresAtMs = Date.now() + ttlMs;
  db.prepare(`
    INSERT INTO telegram_link_sessions (token_hash, account_id, telegram_subject, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashLinkToken(token), identity.account_id, String(chatId), expiresAtMs);
  const appUrl = String(options.appUrl || process.env.PERPSIA_APP_URL || DEFAULT_APP_URL).replace(/\/$/, "");
  return {
    token,
    accountId: identity.account_id,
    expiresAt: new Date(expiresAtMs).toISOString(),
    url: appUrl + "/link?token=" + encodeURIComponent(token),
  };
}

function inspectTelegramLinkSession(token) {
  const session = db.prepare(`
    SELECT expires_at, consumed_at
    FROM telegram_link_sessions
    WHERE token_hash = ?
  `).get(hashLinkToken(token));
  if (!session) return { status: "invalid" };
  if (session.consumed_at) return { status: "used" };
  if (Number(session.expires_at) <= Date.now()) return { status: "expired" };
  return { status: "valid", expiresAt: new Date(Number(session.expires_at)).toISOString() };
}

function consumeTelegramLinkSession(token, provider, subject, metadata = {}) {
  const tokenHash = hashLinkToken(token);
  const session = db.prepare(`
    SELECT * FROM telegram_link_sessions
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
  `).get(tokenHash, Date.now());
  if (!session) throw new Error("This account link has expired or was already used.");

  const normalizedProvider = normalizeProvider(provider);
  const normalizedSubject = normalizeSubject(subject);
  const existing = getIdentity(normalizedProvider, normalizedSubject);
  if (existing && existing.account_id !== session.account_id) {
    throw new Error("This identity is already linked to another PerpsIA account.");
  }

  const link = db.transaction(() => {
    if (!existing) {
      db.prepare(`
        INSERT INTO perpsia_identities (account_id, provider, subject, metadata_json)
        VALUES (?, ?, ?, ?)
      `).run(session.account_id, normalizedProvider, normalizedSubject, JSON.stringify(parseMetadata(metadata)));
    } else {
      db.prepare(`
        UPDATE perpsia_identities
        SET metadata_json = ?, last_seen_at = CURRENT_TIMESTAMP
        WHERE identity_id = ?
      `).run(JSON.stringify(parseMetadata(metadata)), existing.identity_id);
    }
    db.prepare("UPDATE telegram_link_sessions SET consumed_at = CURRENT_TIMESTAMP WHERE session_id = ?").run(session.session_id);
  });
  link();
  return getIdentity(normalizedProvider, normalizedSubject);
}

function getAccountIdentities(accountId) {
  return db.prepare(`
    SELECT identity_id, account_id, provider, subject, metadata_json, created_at, last_seen_at
    FROM perpsia_identities
    WHERE account_id = ?
    ORDER BY created_at ASC, identity_id ASC
  `).all(String(accountId)).map(readIdentity);
}

module.exports = {
  consumeTelegramLinkSession,
  createTelegramLinkSession,
  getAccountIdentities,
  getIdentity,
  getOrCreateIdentity,
  getOrCreateTelegramAccount,
  hashLinkToken,
  inspectTelegramLinkSession,
};
