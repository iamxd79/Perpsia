"use strict";

const crypto = require("crypto");
const { getPool } = require("./postgres");

const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_APP_URL = "https://www.perpsia.app";

function normalizeProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_:-]{1,63}$/.test(value)) throw new Error("A valid identity provider is required.");
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

function hashLinkToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createLinkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readIdentity(row) {
  if (!row) return null;
  return { ...row, metadata: row.metadata || {} };
}

async function getIdentity(provider, subject, client = getPool()) {
  const result = await client.query(`SELECT identity_id, account_id, provider, subject, metadata, created_at, last_seen_at FROM perpsia_identities WHERE provider = $1 AND subject = $2`, [normalizeProvider(provider), normalizeSubject(subject)]);
  return readIdentity(result.rows[0]);
}

async function getOrCreateIdentity(provider, subject, metadata = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSubject = normalizeSubject(subject);
  const safeMetadata = parseMetadata(metadata);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT identity_id, account_id FROM perpsia_identities WHERE provider = $1 AND subject = $2 FOR UPDATE", [normalizedProvider, normalizedSubject]);
    if (existing.rows[0]) {
      await client.query("UPDATE perpsia_identities SET metadata = $1::jsonb, last_seen_at = now() WHERE identity_id = $2", [JSON.stringify(safeMetadata), existing.rows[0].identity_id]);
      await client.query("COMMIT");
      return getIdentity(normalizedProvider, normalizedSubject);
    }
    const accountId = crypto.randomUUID();
    await client.query("INSERT INTO perpsia_accounts(account_id) VALUES ($1)", [accountId]);
    await client.query("INSERT INTO perpsia_identities(account_id, provider, subject, metadata) VALUES ($1,$2,$3,$4::jsonb)", [accountId, normalizedProvider, normalizedSubject, JSON.stringify(safeMetadata)]);
    await client.query("COMMIT");
    return getIdentity(normalizedProvider, normalizedSubject);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505" && error.constraint?.includes("perpsia_identities")) return getIdentity(normalizedProvider, normalizedSubject);
    throw error;
  } finally {
    client.release();
  }
}

async function createLinkTokenSession(accountId, telegramSubject, options = {}) {
  const normalizedAccount = String(accountId);
  const account = await getPool().query("SELECT account_id FROM perpsia_accounts WHERE account_id = $1", [normalizedAccount]);
  if (!account.rows[0]) throw new Error("PerpsIA account was not found.");
  const token = crypto.randomBytes(32).toString("base64url");
  const ttlMs = Math.min(Math.max(Number(options.ttlMs) || DEFAULT_LINK_TTL_MS, 1000), 30 * 60 * 1000);
  const expiresAt = new Date(Date.now() + ttlMs);
  await getPool().query("INSERT INTO telegram_link_sessions(token_hash, account_id, telegram_subject, expires_at) VALUES ($1,$2,$3,$4)", [hashLinkToken(token), normalizedAccount, String(telegramSubject), expiresAt]);
  const appUrl = String(options.appUrl || process.env.PERPSIA_APP_URL || DEFAULT_APP_URL).replace(/\/$/, "");
  return { token, accountId: normalizedAccount, expiresAt: expiresAt.toISOString(), url: `${appUrl}/link?token=${encodeURIComponent(token)}` };
}

async function createTelegramLinkSession(chatId, options = {}) {
  const identity = await getOrCreateIdentity("telegram", String(chatId), options.metadata || {});
  return createLinkTokenSession(identity.account_id, String(chatId), options);
}

async function createWebTelegramLinkSession(accountId, options = {}) {
  const tokenSession = await createLinkTokenSession(accountId, "pending", options);
  const botUsername = String(options.botUsername || process.env.PERPSIA_TELEGRAM_BOT_USERNAME || "perpsia_bot").replace(/^@/, "");
  return { ...tokenSession, telegramUrl: `https://t.me/${encodeURIComponent(botUsername)}?start=link_${encodeURIComponent(tokenSession.token)}` };
}

async function inspectTelegramLinkSession(token) {
  const result = await getPool().query("SELECT expires_at, consumed_at FROM telegram_link_sessions WHERE token_hash = $1", [hashLinkToken(token)]);
  const session = result.rows[0];
  if (!session) return { status: "invalid" };
  if (session.consumed_at) return { status: "used" };
  if (new Date(session.expires_at).getTime() <= Date.now()) return { status: "expired" };
  return { status: "valid", expiresAt: new Date(session.expires_at).toISOString() };
}

async function consumeTelegramLinkSession(token, provider, subject, metadata = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSubject = normalizeSubject(subject);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const sessionResult = await client.query("SELECT * FROM telegram_link_sessions WHERE token_hash = $1 FOR UPDATE", [hashLinkToken(token)]);
    const session = sessionResult.rows[0];
    if (!session) throw createLinkError("LINK_INVALID", "This account link is invalid.");
    if (session.consumed_at) throw createLinkError("LINK_USED", "This account link was already used.");
    if (new Date(session.expires_at).getTime() <= Date.now()) throw createLinkError("LINK_EXPIRED", "This account link has expired.");
    if (session.telegram_subject === "pending") throw createLinkError("LINK_DIRECTION", "This link must be completed in Telegram.");
    const existing = await getIdentity(normalizedProvider, normalizedSubject, client);
    if (existing && existing.account_id !== session.account_id) throw createLinkError("IDENTITY_CONFLICT", "This identity is already linked to another PerpsIA account.");
    if (!existing) await client.query("INSERT INTO perpsia_identities(account_id, provider, subject, metadata) VALUES ($1,$2,$3,$4::jsonb)", [session.account_id, normalizedProvider, normalizedSubject, JSON.stringify(parseMetadata(metadata))]);
    else await client.query("UPDATE perpsia_identities SET metadata=$1::jsonb, last_seen_at=now() WHERE identity_id=$2", [JSON.stringify(parseMetadata(metadata)), existing.identity_id]);
    await client.query("UPDATE telegram_link_sessions SET consumed_at=now() WHERE session_id=$1", [session.session_id]);
    await client.query("COMMIT");
    return getIdentity(normalizedProvider, normalizedSubject);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function consumeWebTelegramLinkSession(token, chatId, metadata = {}) {
  const normalizedChatId = normalizeSubject(chatId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const sessionResult = await client.query("SELECT * FROM telegram_link_sessions WHERE token_hash = $1 FOR UPDATE", [hashLinkToken(token)]);
    const session = sessionResult.rows[0];
    if (!session) throw createLinkError("LINK_INVALID", "This Telegram link is invalid.");
    if (session.consumed_at) throw createLinkError("LINK_USED", "This Telegram link was already used.");
    if (new Date(session.expires_at).getTime() <= Date.now()) throw createLinkError("LINK_EXPIRED", "This Telegram link has expired.");
    if (session.telegram_subject !== "pending") throw createLinkError("LINK_DIRECTION", "This link must be completed on the PerpsIA web app.");
    const existing = await getIdentity("telegram", normalizedChatId, client);
    if (existing && existing.account_id !== session.account_id) throw createLinkError("IDENTITY_CONFLICT", "This Telegram account is already linked to another PerpsIA account.");
    if (!existing) await client.query("INSERT INTO perpsia_identities(account_id, provider, subject, metadata) VALUES ($1,'telegram',$2,$3::jsonb)", [session.account_id, normalizedChatId, JSON.stringify(parseMetadata(metadata))]);
    else await client.query("UPDATE perpsia_identities SET metadata=$1::jsonb, last_seen_at=now() WHERE identity_id=$2", [JSON.stringify(parseMetadata(metadata)), existing.identity_id]);
    await client.query("UPDATE telegram_link_sessions SET telegram_subject=$1, consumed_at=now() WHERE session_id=$2", [normalizedChatId, session.session_id]);
    await client.query("COMMIT");
    return getIdentity("telegram", normalizedChatId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getAccountIdentities(accountId) {
  const result = await getPool().query("SELECT identity_id, account_id, provider, subject, metadata, created_at, last_seen_at FROM perpsia_identities WHERE account_id = $1 ORDER BY created_at, identity_id", [String(accountId)]);
  return result.rows.map(readIdentity);
}

module.exports = { consumeTelegramLinkSession, consumeWebTelegramLinkSession, createTelegramLinkSession, createWebTelegramLinkSession, getAccountIdentities, getIdentity, getOrCreateIdentity, hashLinkToken, inspectTelegramLinkSession };
