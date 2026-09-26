"use strict";

const fs = require("fs");
const path = require("path");
const { getPool, isConfigured } = require("../services/postgres");

const migrationsDir = path.join(__dirname, "..", "migrations");

async function migrate({ dryRun = false } = {}) {
  const files = fs.readdirSync(migrationsDir).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  if (dryRun) return { dryRun: true, pending: files };
  if (!isConfigured()) throw new Error("Set PERPSIA_DATABASE_URL, SUPABASE_DB_URL, or DATABASE_URL first.");
  const db = getPool();
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const applied = new Set((await db.query("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
  const completed = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      completed.push(file);
    } catch (error) { await client.query("ROLLBACK"); throw new Error(`${file}: ${error.message}`); } finally { client.release(); }
  }
  return { dryRun: false, applied: completed, pending: files.filter((file) => !applied.has(file) && !completed.includes(file)) };
}

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  migrate({ dryRun }).then(async (result) => { console.log(JSON.stringify(result, null, 2)); if (!dryRun && isConfigured()) await getPool().end(); }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { migrate };
