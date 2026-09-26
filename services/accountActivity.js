"use strict";

const { openDatabase } = require("./database");
const { resolveAccountIdForChat } = require("./accountData");

const db = openDatabase();
db.exec(`
  CREATE TABLE IF NOT EXISTS account_analysis_history (
    analysis_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    venue TEXT,
    analysis_type TEXT NOT NULL,
    request_source TEXT NOT NULL,
    result_reference TEXT,
    signal_reference TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_account_analysis_history_account_time ON account_analysis_history(account_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS account_usage_events (
    usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function recordAccountAnalysis(chatId, analysis = {}) {
  const accountId = resolveAccountIdForChat(chatId);
  const result = db.prepare(`INSERT INTO account_analysis_history (account_id, symbol, venue, analysis_type, request_source, result_reference, signal_reference, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(accountId, String(analysis.symbol || "").toUpperCase(), analysis.venue || null, String(analysis.analysisType || "asset_analysis"), String(analysis.requestSource || "telegram"), analysis.resultReference || null, analysis.signalReference || null, JSON.stringify(analysis.metadata || {}));
  db.prepare("INSERT INTO account_usage_events (account_id, event_type, metadata_json) VALUES (?, ?, ?)").run(accountId, "analysis", JSON.stringify({ symbol: analysis.symbol, source: analysis.requestSource || "telegram" }));
  return result.lastInsertRowid;
}

function getAccountAnalyses(accountId, limit = 50) {
  return db.prepare("SELECT analysis_id, symbol, venue, analysis_type, request_source, result_reference, signal_reference, created_at FROM account_analysis_history WHERE account_id = ? ORDER BY created_at DESC, analysis_id DESC LIMIT ?")
    .all(String(accountId), Math.min(Math.max(Number(limit) || 50, 1), 100));
}

module.exports = { getAccountAnalyses, recordAccountAnalysis };
