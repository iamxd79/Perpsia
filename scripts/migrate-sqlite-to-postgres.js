"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { getPool, isConfigured } = require("../services/postgres");

function sourcePath() {
  return path.resolve(process.env.PERPSIA_DB_PATH || path.join(__dirname, "..", "perpsia.db"));
}

function tableExists(db, table) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
function rows(db, table, query = `SELECT * FROM ${table}`) { return tableExists(db, table) ? db.prepare(query).all() : []; }

function buildPlan(db) {
  const identities = rows(db, "perpsia_identities");
  const identityByTelegram = new Map(identities.filter((row) => row.provider === "telegram").map((row) => [String(row.subject), row.account_id]));
  const mapByAccount = (table) => rows(db, table).map((row) => ({ ...row, account_id: row.account_id || identityByTelegram.get(String(row.chat_id)) || null }));
  const paper = mapByAccount("paper_positions");
  const conflicts = [];
  for (const row of paper.filter((item) => !item.account_id)) conflicts.push({ table: "paper_positions", key: row.id, reason: "telegram identity not found" });
  return {
    accounts: rows(db, "perpsia_accounts"),
    identities,
    wallets: rows(db, "account_wallets"),
    preferences: rows(db, "account_preferences"),
    risk: rows(db, "account_risk_profiles"),
    watchlist: rows(db, "account_watchlist"),
    paperPositions: paper,
    conflicts,
  };
}

function report(plan) {
  return {
    accounts: plan.accounts.length,
    telegramIdentities: plan.identities.filter((row) => row.provider === "telegram").length,
    identities: plan.identities.length,
    wallets: plan.wallets.length,
    preferences: plan.preferences.length,
    riskProfiles: plan.risk.length,
    watchlistRows: plan.watchlist.length,
    paperPositions: plan.paperPositions.filter((row) => row.account_id).length,
    conflicts: plan.conflicts.length,
  };
}

async function applyPlan(plan) {
  if (!isConfigured()) throw new Error("Set PERPSIA_DATABASE_URL, SUPABASE_DB_URL, or DATABASE_URL first.");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const row of plan.accounts) await client.query("INSERT INTO perpsia_accounts(account_id,status,created_at,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET status=EXCLUDED.status, updated_at=EXCLUDED.updated_at", [row.account_id, row.status, row.created_at, row.updated_at]);
    for (const row of plan.identities) await client.query("INSERT INTO perpsia_identities(account_id,provider,subject,metadata,created_at,last_seen_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider,subject) DO UPDATE SET account_id=EXCLUDED.account_id, metadata=EXCLUDED.metadata, last_seen_at=EXCLUDED.last_seen_at", [row.account_id, row.provider, row.subject, JSON.parse(row.metadata_json || "{}"), row.created_at, row.last_seen_at]);
    for (const row of plan.wallets) await client.query("INSERT INTO account_wallets(account_id,chain_namespace,chain_id,address_normalized,address_display,wallet_type,provider,custody,ownership_status,is_primary,metadata,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(chain_namespace,chain_id,address_normalized) DO NOTHING", [row.account_id, row.chain_namespace, row.chain_id, row.address_normalized, row.address_display, row.wallet_type, row.provider, row.custody, row.ownership_status, Boolean(row.is_primary), JSON.parse(row.metadata_json || "{}"), row.created_at, row.updated_at]);
    for (const row of plan.preferences) await client.query("INSERT INTO account_preferences(account_id,preferred_exchange,alert_frequency,signal_sensitivity,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id) DO UPDATE SET preferred_exchange=EXCLUDED.preferred_exchange, alert_frequency=EXCLUDED.alert_frequency, signal_sensitivity=EXCLUDED.signal_sensitivity, updated_at=EXCLUDED.updated_at", [row.account_id, row.preferred_exchange, row.alert_frequency, row.signal_sensitivity, row.updated_at]);
    for (const row of plan.risk) await client.query("INSERT INTO account_risk_profiles(account_id,capital,risk_percent,max_leverage,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id) DO UPDATE SET capital=EXCLUDED.capital, risk_percent=EXCLUDED.risk_percent, max_leverage=EXCLUDED.max_leverage, updated_at=EXCLUDED.updated_at", [row.account_id, row.capital, row.risk_percent, row.max_leverage, row.updated_at]);
    for (const row of plan.watchlist) await client.query("INSERT INTO account_watchlist(account_id,symbol,created_at) VALUES($1,$2,$3) ON CONFLICT(account_id,symbol) DO NOTHING", [row.account_id, row.symbol, row.created_at]);
    for (const row of plan.paperPositions.filter((item) => item.account_id)) await client.query(`INSERT INTO account_paper_positions(account_id,symbol,venue,direction,margin,leverage,notional,quantity,entry_price,mark_price,stop_loss,take_profit,status,realized_pnl,exit_price,exit_reason,opened_at,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [row.account_id, row.symbol, row.venue, row.direction, row.margin, row.leverage, row.notional, row.quantity, row.entry_price, row.mark_price, row.stop_loss, row.take_profit, row.status, row.realized_pnl, row.exit_price, row.exit_reason, row.opened_at, row.closed_at]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function main() {
  const dbFile = sourcePath();
  if (!fs.existsSync(dbFile)) throw new Error(`SQLite database not found: ${dbFile}`);
  const db = new Database(dbFile, { readonly: true });
  try {
    const plan = buildPlan(db);
    const result = { source: dbFile, mode: process.argv.includes("--apply") ? "apply" : "dry-run", ...report(plan), conflicts: plan.conflicts };
    if (process.argv.includes("--apply")) await applyPlan(plan);
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { buildPlan, report };
