"use strict";

const { openDatabase } = require("./database");
const { getIdentity, getOrCreateTelegramAccount } = require("./accountIdentity");

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS user_preferences (
    chat_id TEXT PRIMARY KEY,
    preferred_exchange TEXT NOT NULL DEFAULT 'Binance',
    alert_frequency TEXT NOT NULL DEFAULT '4h',
    signal_sensitivity TEXT NOT NULL DEFAULT 'balanced',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_risk_settings (
    chat_id TEXT PRIMARY KEY,
    capital REAL,
    risk_percent REAL,
    max_leverage REAL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_watchlist (
    chat_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(chat_id, symbol)
  );
  CREATE TABLE IF NOT EXISTS account_preferences (
    account_id TEXT PRIMARY KEY,
    preferred_exchange TEXT NOT NULL DEFAULT 'Binance',
    alert_frequency TEXT NOT NULL DEFAULT '4h',
    signal_sensitivity TEXT NOT NULL DEFAULT 'balanced',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(account_id) REFERENCES perpsia_accounts(account_id)
  );
  CREATE TABLE IF NOT EXISTS account_risk_profiles (
    account_id TEXT PRIMARY KEY,
    capital REAL,
    risk_percent REAL,
    max_leverage REAL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(account_id) REFERENCES perpsia_accounts(account_id)
  );
  CREATE TABLE IF NOT EXISTS account_watchlist (
    account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(account_id, symbol),
    FOREIGN KEY(account_id) REFERENCES perpsia_accounts(account_id)
  );
`);

for (const table of ["user_preferences", "user_risk_settings", "user_watchlist"]) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN account_id TEXT`).run(); } catch {}
}

function ensureAccountForChat(chatId) {
  const identity = getOrCreateTelegramAccount(String(chatId));
  const accountId = identity.account_id;
  for (const table of ["user_preferences", "user_risk_settings", "user_watchlist"]) {
    db.prepare(`UPDATE ${table} SET account_id = ? WHERE chat_id = ? AND (account_id IS NULL OR account_id = '')`).run(accountId, String(chatId));
  }
  db.prepare(`INSERT OR IGNORE INTO account_preferences (account_id, preferred_exchange, alert_frequency, signal_sensitivity)
    SELECT account_id, preferred_exchange, alert_frequency, signal_sensitivity FROM user_preferences WHERE account_id = ?`).run(accountId);
  db.prepare(`INSERT OR IGNORE INTO account_risk_profiles (account_id, capital, risk_percent, max_leverage)
    SELECT account_id, capital, risk_percent, max_leverage FROM user_risk_settings WHERE account_id = ?`).run(accountId);
  db.prepare(`INSERT OR IGNORE INTO account_watchlist (account_id, symbol, created_at)
    SELECT account_id, symbol, created_at FROM user_watchlist WHERE account_id = ?`).run(accountId);
  return accountId;
}

function resolveAccountIdForChat(chatId) { return ensureAccountForChat(chatId); }

function getAccountPreferences(accountId) {
  return db.prepare("SELECT account_id, preferred_exchange, alert_frequency, signal_sensitivity, updated_at FROM account_preferences WHERE account_id = ?")
    .get(String(accountId)) || { account_id: String(accountId), preferred_exchange: "Binance", alert_frequency: "4h", signal_sensitivity: "balanced", updated_at: null };
}

function saveAccountPreferences(accountId, updates = {}) {
  const current = getAccountPreferences(accountId);
  db.prepare(`INSERT INTO account_preferences (account_id, preferred_exchange, alert_frequency, signal_sensitivity, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(account_id) DO UPDATE SET preferred_exchange=excluded.preferred_exchange, alert_frequency=excluded.alert_frequency, signal_sensitivity=excluded.signal_sensitivity, updated_at=CURRENT_TIMESTAMP`)
    .run(String(accountId), updates.preferred_exchange || current.preferred_exchange, updates.alert_frequency || current.alert_frequency, updates.signal_sensitivity || current.signal_sensitivity);
  return getAccountPreferences(accountId);
}

function getAccountRisk(accountId) {
  return db.prepare("SELECT account_id, capital, risk_percent, max_leverage, updated_at FROM account_risk_profiles WHERE account_id = ?").get(String(accountId)) || null;
}

function saveAccountRisk(accountId, capital, riskPercent, maxLeverage) {
  db.prepare(`INSERT INTO account_risk_profiles (account_id, capital, risk_percent, max_leverage, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(account_id) DO UPDATE SET capital=excluded.capital, risk_percent=excluded.risk_percent, max_leverage=excluded.max_leverage, updated_at=CURRENT_TIMESTAMP`)
    .run(String(accountId), capital, riskPercent, maxLeverage);
  return getAccountRisk(accountId);
}

function getAccountWatchlist(accountId) {
  return db.prepare("SELECT symbol, created_at FROM account_watchlist WHERE account_id = ? ORDER BY created_at ASC, symbol ASC").all(String(accountId));
}

function addAccountWatchlist(accountId, symbol) {
  db.prepare("INSERT OR IGNORE INTO account_watchlist (account_id, symbol) VALUES (?, ?)").run(String(accountId), String(symbol));
  return getAccountWatchlist(accountId);
}

function removeAccountWatchlist(accountId, symbol) {
  db.prepare("DELETE FROM account_watchlist WHERE account_id = ? AND symbol = ?").run(String(accountId), String(symbol));
  return getAccountWatchlist(accountId);
}

function getAccountOverview(accountId) {
  const id = String(accountId);
  const account = db.prepare("SELECT account_id, status, created_at, updated_at FROM perpsia_accounts WHERE account_id = ?").get(id);
  if (!account) return null;
  const identities = require("./accountIdentity").getAccountIdentities(id).map((item) => ({ provider: item.provider, createdAt: item.created_at, lastSeenAt: item.last_seen_at }));
  return { account, identities, preferences: getAccountPreferences(id), risk: getAccountRisk(id), watchlist: getAccountWatchlist(id) };
}

function getAccountIdForPrivy(subject) { return getIdentity("privy", subject)?.account_id || null; }

module.exports = { resolveAccountIdForChat, getAccountPreferences, saveAccountPreferences, getAccountRisk, saveAccountRisk, getAccountWatchlist, addAccountWatchlist, removeAccountWatchlist, getAccountOverview, getAccountIdForPrivy };
