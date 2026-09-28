"use strict";

const crypto = require("crypto");
const { openDatabase } = require("./database");
const { isConfigured: isPostgresConfigured } = require("./postgres");
const postgresIdentity = require("./postgresIdentity");

const usePostgres = isPostgresConfigured();
const db = usePostgres ? null : openDatabase();
const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_APP_URL = "https://www.perpsia.app";

if (!usePostgres) db.exec(`
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
  if (usePostgres) return postgresIdentity.getIdentity(provider, subject);
  const row = db.prepare(`
    SELECT identity_id, account_id, provider, subject, metadata_json, created_at, last_seen_at
    FROM perpsia_identities
    WHERE provider = ? AND subject = ?
  `).get(normalizeProvider(provider), normalizeSubject(subject));
  return readIdentity(row);
}

function getOrCreateIdentity(provider, subject, metadata = {}) {
  if (usePostgres) return postgresIdentity.getOrCreateIdentity(provider, subject, metadata);
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
  try {
    create();
  } catch (error) {
    if (/UNIQUE constraint failed: perpsia_identities\.provider, perpsia_identities\.subject/i.test(error.message || "")) {
      return getIdentity(normalizedProvider, normalizedSubject);
    }
    throw error;
  }
  return getIdentity(normalizedProvider, normalizedSubject);
}

function getOrCreateTelegramAccount(chatId, metadata = {}) {
  return getOrCreateIdentity("telegram", String(chatId), metadata);
}

function hashLinkToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createLinkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createLinkTokenSession(accountId, telegramSubject, options = {}) {
  const account = db.prepare("SELECT account_id FROM perpsia_accounts WHERE account_id = ?").get(String(accountId));
  if (!account) throw new Error("PerpsIA account was not found.");
  const token = crypto.randomBytes(32).toString("base64url");
  const ttlMs = Math.min(
    Math.max(Number(options.ttlMs) || DEFAULT_LINK_TTL_MS, 1000),
    30 * 60 * 1000,
  );
  const expiresAtMs = Date.now() + ttlMs;
  db.prepare(`
    INSERT INTO telegram_link_sessions (token_hash, account_id, telegram_subject, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashLinkToken(token), String(accountId), String(telegramSubject), expiresAtMs);
  const appUrl = String(options.appUrl || process.env.PERPSIA_APP_URL || DEFAULT_APP_URL).replace(/\/$/, "");
  return {
    token,
    accountId: String(accountId),
    expiresAt: new Date(expiresAtMs).toISOString(),
    url: appUrl + "/link?token=" + encodeURIComponent(token),
  };
}

function createTelegramLinkSession(chatId, options = {}) {
  if (usePostgres) return postgresIdentity.createTelegramLinkSession(chatId, options);
  const identity = getOrCreateTelegramAccount(chatId, options.metadata || {});
  return createLinkTokenSession(identity.account_id, String(chatId), options);
}

function createWebTelegramLinkSession(accountId, options = {}) {
  if (usePostgres) return postgresIdentity.createWebTelegramLinkSession(accountId, options);
  const tokenSession = createLinkTokenSession(accountId, "pending", options);
  const botUsername = String(options.botUsername || process.env.PERPSIA_TELEGRAM_BOT_USERNAME || "perpsia_bot").replace(/^@/, "");
  return {
    ...tokenSession,
    telegramUrl: "https://t.me/" + encodeURIComponent(botUsername) + "?start=link_" + encodeURIComponent(tokenSession.token),
  };
}

function inspectTelegramLinkSession(token) {
  if (usePostgres) return postgresIdentity.inspectTelegramLinkSession(token);
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
  if (usePostgres) return postgresIdentity.consumeTelegramLinkSession(token, provider, subject, metadata);
  const tokenHash = hashLinkToken(token);
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSubject = normalizeSubject(subject);
  let linked;
  const link = db.transaction(() => {
    const session = db.prepare("SELECT * FROM telegram_link_sessions WHERE token_hash = ?").get(tokenHash);
    if (!session) throw createLinkError("LINK_INVALID", "This account link is invalid.");
    if (session.consumed_at) throw createLinkError("LINK_USED", "This account link was already used.");
    if (Number(session.expires_at) <= Date.now()) throw createLinkError("LINK_EXPIRED", "This account link has expired.");
    if (session.telegram_subject === "pending") throw createLinkError("LINK_DIRECTION", "This link must be completed in Telegram.");
    const existing = getIdentity(normalizedProvider, normalizedSubject);
    if (existing && existing.account_id !== session.account_id) {
      throw createLinkError("IDENTITY_CONFLICT", "This identity is already linked to another PerpsIA account.");
    }
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
    const consumed = db.prepare("UPDATE telegram_link_sessions SET consumed_at = CURRENT_TIMESTAMP WHERE session_id = ? AND consumed_at IS NULL").run(session.session_id);
    if (consumed.changes !== 1) throw createLinkError("LINK_USED", "This account link was already used.");
    linked = getIdentity(normalizedProvider, normalizedSubject);
  });
  link();
  return linked;
}

function consumeWebTelegramLinkSession(token, chatId, metadata = {}) {
  if (usePostgres) return postgresIdentity.consumeWebTelegramLinkSession(token, chatId, metadata);
  const tokenHash = hashLinkToken(token);
  const normalizedChatId = normalizeSubject(chatId);
  let linked;
  const link = db.transaction(() => {
    const session = db.prepare("SELECT * FROM telegram_link_sessions WHERE token_hash = ?").get(tokenHash);
    if (!session) throw createLinkError("LINK_INVALID", "This Telegram link is invalid.");
    if (session.consumed_at) throw createLinkError("LINK_USED", "This Telegram link was already used.");
    if (Number(session.expires_at) <= Date.now()) throw createLinkError("LINK_EXPIRED", "This Telegram link has expired.");
    if (session.telegram_subject !== "pending") throw createLinkError("LINK_DIRECTION", "This link must be completed on the PerpsIA web app.");
    const existing = getIdentity("telegram", normalizedChatId);
    if (existing && existing.account_id !== session.account_id) {
      throw createLinkError("IDENTITY_CONFLICT", "This Telegram account is already linked to another PerpsIA account.");
    }
    if (!existing) {
      db.prepare(`
        INSERT INTO perpsia_identities (account_id, provider, subject, metadata_json)
        VALUES (?, 'telegram', ?, ?)
      `).run(session.account_id, normalizedChatId, JSON.stringify(parseMetadata(metadata)));
    } else {
      db.prepare(`UPDATE perpsia_identities SET metadata_json = ?, last_seen_at = CURRENT_TIMESTAMP WHERE identity_id = ?`)
        .run(JSON.stringify(parseMetadata(metadata)), existing.identity_id);
    }
    const consumed = db.prepare("UPDATE telegram_link_sessions SET telegram_subject = ?, consumed_at = CURRENT_TIMESTAMP WHERE session_id = ? AND consumed_at IS NULL").run(normalizedChatId, session.session_id);
    if (consumed.changes !== 1) throw createLinkError("LINK_USED", "This Telegram link was already used.");
    linked = getIdentity("telegram", normalizedChatId);
  });
  link();
  return linked;
}

function getAccountIdentities(accountId) {
  if (usePostgres) return postgresIdentity.getAccountIdentities(accountId);
  return db.prepare(`
    SELECT identity_id, account_id, provider, subject, metadata_json, created_at, last_seen_at
    FROM perpsia_identities
    WHERE account_id = ?
    ORDER BY created_at ASC, identity_id ASC
  `).all(String(accountId)).map(readIdentity);
}

module.exports = {
  consumeTelegramLinkSession,
  consumeWebTelegramLinkSession,
  createTelegramLinkSession,
  createWebTelegramLinkSession,
  getAccountIdentities,
  getIdentity,
  getOrCreateIdentity,
  getOrCreateTelegramAccount,
  hashLinkToken,
  inspectTelegramLinkSession,
  isPostgresIdentityEnabled: () => usePostgres,
};
