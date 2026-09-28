"use strict";

const { Pool } = require("pg");

let pool;

function getPostgresUrl() {
  return String(process.env.PERPSIA_DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "").trim();
}

function isConfigured() { return Boolean(getPostgresUrl()); }

function getPool() {
  const connectionString = getPostgresUrl();
  if (!connectionString) throw new Error("PostgreSQL is not configured.");
  if (!pool) {
    const configuredIpFamily = Number(process.env.PERPSIA_DATABASE_IP_FAMILY || 4);
    const ipFamily = configuredIpFamily === 6 ? 6 : 4;
    pool = new Pool({
      connectionString,
      ssl: process.env.PERPSIA_DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
      max: Number(process.env.PERPSIA_DATABASE_POOL_SIZE || 5),
      connectionTimeoutMillis: 8000,
      family: ipFamily,
    });
  }
  return pool;
}

async function checkPostgres() {
  const client = await getPool().connect();
  try { const result = await client.query("SELECT 1 AS ok"); return result.rows[0]; } finally { client.release(); }
}

async function closePostgres() { if (pool) { await pool.end(); pool = null; } }

module.exports = { checkPostgres, closePostgres, getPool, getPostgresUrl, isConfigured };
