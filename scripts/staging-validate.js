"use strict";

const { getPool, isConfigured } = require("../services/postgres");
const expectedTables = ["perpsia_accounts", "perpsia_identities", "account_wallets", "account_preferences", "account_risk_profiles", "account_watchlist", "account_analysis_history", "account_alerts", "account_paper_positions", "account_usage_events", "token_assets", "wallet_token_balances", "staking_positions", "entitlements", "account_staking_positions", "staking_events", "staking_checkpoints", "account_entitlements"];
async function validate() {
  if (!isConfigured()) throw new Error("Set PERPSIA_DATABASE_URL, SUPABASE_DB_URL, or DATABASE_URL first.");
  const db = getPool();
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])", [expectedTables])).rows.map((row) => row.table_name);
  const missing = expectedTables.filter((table) => !tables.includes(table));
  const checks = {
    tables: { expected: expectedTables.length, present: tables.length, missing },
    indexes: (await db.query("SELECT COUNT(*)::int AS count FROM pg_indexes WHERE schemaname = 'public'")).rows[0].count,
    foreignKeys: (await db.query("SELECT COUNT(*)::int AS count FROM information_schema.table_constraints WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'")).rows[0].count,
    accounts: (await db.query("SELECT COUNT(*)::int AS count FROM perpsia_accounts")).rows[0].count,
    wallets: (await db.query("SELECT COUNT(*)::int AS count FROM account_wallets")).rows[0].count,
    alerts: (await db.query("SELECT COUNT(*)::int AS count FROM account_alerts")).rows[0].count,
    paperTrading: (await db.query("SELECT COUNT(*)::int AS count FROM account_paper_positions")).rows[0].count,
    analyses: (await db.query("SELECT COUNT(*)::int AS count FROM account_analysis_history")).rows[0].count,
    usageEvents: (await db.query("SELECT COUNT(*)::int AS count FROM account_usage_events")).rows[0].count,
  };
  return { ok: missing.length === 0, checks };
}
if (require.main === module) validate().then(async (result) => { console.log(JSON.stringify(result, null, 2)); await getPool().end(); if (!result.ok) process.exitCode = 2; }).catch(async (error) => { console.error(error.message); if (isConfigured()) await getPool().end(); process.exitCode = 1; });
module.exports = { expectedTables, validate };
