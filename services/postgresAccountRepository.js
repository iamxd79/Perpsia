"use strict";

const { getPool } = require("./postgres");

async function getAccountOverview(accountId) {
  const db = getPool();
  const account = await db.query("SELECT account_id, status, created_at, updated_at FROM perpsia_accounts WHERE account_id = $1", [String(accountId)]);
  if (!account.rows[0]) return null;
  const [identities, wallets, preferences, risk, watchlist, analyses] = await Promise.all([
    db.query("SELECT provider, created_at, last_seen_at FROM perpsia_identities WHERE account_id = $1 ORDER BY created_at", [accountId]),
    db.query("SELECT wallet_id, chain_namespace, chain_id, address_display, wallet_type, provider, custody, ownership_status, is_primary, created_at FROM account_wallets WHERE account_id = $1 ORDER BY is_primary DESC, created_at", [accountId]),
    db.query("SELECT * FROM account_preferences WHERE account_id = $1", [accountId]),
    db.query("SELECT * FROM account_risk_profiles WHERE account_id = $1", [accountId]),
    db.query("SELECT symbol, created_at FROM account_watchlist WHERE account_id = $1 ORDER BY created_at", [accountId]),
    db.query("SELECT analysis_id, symbol, venue, analysis_type, request_source, signal_reference, created_at FROM account_analysis_history WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50", [accountId]),
  ]);
  return { account: account.rows[0], identities: identities.rows, wallets: wallets.rows, preferences: preferences.rows[0] || null, risk: risk.rows[0] || null, watchlist: watchlist.rows, analyses: analyses.rows };
}

async function recordAnalysis(accountId, analysis) {
  const result = await getPool().query(`INSERT INTO account_analysis_history (account_id, symbol, venue, analysis_type, request_source, result_reference, signal_reference, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING analysis_id, created_at`, [accountId, analysis.symbol, analysis.venue || null, analysis.analysisType, analysis.requestSource, analysis.resultReference || null, analysis.signalReference || null, analysis.metadata || {}]);
  return result.rows[0];
}

module.exports = { getAccountOverview, recordAnalysis };
