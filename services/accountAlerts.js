"use strict";

const { openDatabase } = require("./database");

const db = openDatabase();
db.exec(`
  CREATE TABLE IF NOT EXISTS account_alerts (
    alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    symbol TEXT,
    alert_type TEXT NOT NULL,
    condition_json TEXT NOT NULL DEFAULT '{}',
    destinations_json TEXT NOT NULL DEFAULT '["telegram"]',
    status TEXT NOT NULL DEFAULT 'active',
    last_triggered_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_account_alerts_account_status ON account_alerts(account_id, status);
`);

function parseJson(value, fallback) { try { return JSON.parse(value || ""); } catch { return fallback; } }
function readAlert(row) {
  return row && { alertId: row.alert_id, accountId: row.account_id, symbol: row.symbol, alertType: row.alert_type, condition: parseJson(row.condition_json, {}), destinations: parseJson(row.destinations_json, ["telegram"]), status: row.status, lastTriggeredAt: row.last_triggered_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function createAccountAlert(accountId, input = {}) {
  const destinations = Array.isArray(input.destinations) && input.destinations.length ? input.destinations : ["telegram"];
  const result = db.prepare("INSERT INTO account_alerts (account_id, symbol, alert_type, condition_json, destinations_json) VALUES (?, ?, ?, ?, ?)")
    .run(String(accountId), input.symbol ? String(input.symbol).toUpperCase() : null, String(input.alertType || "signal"), JSON.stringify(input.condition || {}), JSON.stringify(destinations));
  return getAccountAlert(accountId, result.lastInsertRowid);
}

function getAccountAlert(accountId, alertId) { return readAlert(db.prepare("SELECT * FROM account_alerts WHERE account_id = ? AND alert_id = ?").get(String(accountId), Number(alertId))); }
function listAccountAlerts(accountId, status = null) {
  const rows = status ? db.prepare("SELECT * FROM account_alerts WHERE account_id = ? AND status = ? ORDER BY created_at DESC").all(String(accountId), String(status)) : db.prepare("SELECT * FROM account_alerts WHERE account_id = ? ORDER BY created_at DESC").all(String(accountId));
  return rows.map(readAlert);
}
function updateAccountAlert(accountId, alertId, updates = {}) {
  const current = getAccountAlert(accountId, alertId);
  if (!current) return null;
  db.prepare("UPDATE account_alerts SET status = ?, destinations_json = ?, condition_json = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND alert_id = ?")
    .run(updates.status || current.status, JSON.stringify(updates.destinations || current.destinations), JSON.stringify(updates.condition || current.condition), String(accountId), Number(alertId));
  return getAccountAlert(accountId, alertId);
}
function deleteAccountAlert(accountId, alertId) { return db.prepare("DELETE FROM account_alerts WHERE account_id = ? AND alert_id = ?").run(String(accountId), Number(alertId)).changes > 0; }

module.exports = { createAccountAlert, deleteAccountAlert, getAccountAlert, listAccountAlerts, updateAccountAlert };
