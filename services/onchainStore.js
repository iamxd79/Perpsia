"use strict";

const { openDatabase } = require("./database");

let db = null;

function requireDb() {
  if (!db) {
    db = openDatabase();
    db.exec([
      "CREATE TABLE IF NOT EXISTS onchain_events (",
      "event_key TEXT PRIMARY KEY,",
      "provider TEXT NOT NULL,",
      "chain TEXT,",
      "asset_symbol TEXT,",
      "contract_address TEXT,",
      "tx_hash TEXT,",
      "from_address TEXT,",
      "to_address TEXT,",
      "amount REAL,",
      "decimals INTEGER,",
      "value_usd REAL,",
      "event_time INTEGER,",
      "payload_json TEXT NOT NULL,",
      "received_at INTEGER NOT NULL",
      ");",
      "CREATE INDEX IF NOT EXISTS idx_onchain_event_time ON onchain_events(event_time);",
      "CREATE INDEX IF NOT EXISTS idx_onchain_event_asset ON onchain_events(asset_symbol, chain, event_time);",
      "CREATE INDEX IF NOT EXISTS idx_onchain_event_hash ON onchain_events(tx_hash);",
    ].join("\n"));
  }
  return db;
}

function safeJson(value) {
  try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
}

function normalizeEvent(input = {}) {
  const eventKey = String(input.eventKey || input.id || "").trim();
  if (!eventKey) return null;
  return {
    eventKey,
    provider: String(input.provider || "alchemy").toLowerCase(),
    chain: input.chain ? String(input.chain).toLowerCase() : null,
    assetSymbol: input.assetSymbol ? String(input.assetSymbol).toUpperCase() : null,
    contractAddress: input.contractAddress ? String(input.contractAddress).toLowerCase() : null,
    txHash: input.txHash || input.hash || null,
    fromAddress: input.fromAddress || input.from || null,
    toAddress: input.toAddress || input.to || null,
    amount: Number.isFinite(Number(input.amount)) ? Number(input.amount) : null,
    decimals: Number.isInteger(Number(input.decimals)) ? Number(input.decimals) : null,
    valueUsd: Number.isFinite(Number(input.valueUsd)) ? Number(input.valueUsd) : null,
    eventTime: Number.isFinite(Number(input.eventTime ?? input.timestamp))
      ? Number(input.eventTime ?? input.timestamp)
      : Date.now(),
    payload: input.payload || input,
  };
}

function recordOnchainEvents(events = []) {
  const store = requireDb();
  const insert = store.prepare([
    "INSERT OR IGNORE INTO onchain_events (",
    "event_key, provider, chain, asset_symbol, contract_address, tx_hash,",
    "from_address, to_address, amount, decimals, value_usd, event_time, payload_json, received_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join("\n"));
  const transaction = store.transaction((items) => {
    let inserted = 0;
    let duplicates = 0;
    for (const raw of items) {
      const event = normalizeEvent(raw);
      if (!event) continue;
      const result = insert.run(
        event.eventKey,
        event.provider,
        event.chain,
        event.assetSymbol,
        event.contractAddress,
        event.txHash,
        event.fromAddress,
        event.toAddress,
        event.amount,
        event.decimals,
        event.valueUsd,
        event.eventTime,
        safeJson(event.payload),
        Date.now(),
      );
      if (result.changes) inserted += 1;
      else duplicates += 1;
    }
    return { inserted, duplicates };
  });
  return transaction(Array.isArray(events) ? events : []);
}

function listOnchainEvents(options = {}) {
  const store = requireDb();
  const cutoff = Date.now() - Math.max(1, Number(options.lookbackHours || 24)) * 60 * 60 * 1000;
  const limit = Math.max(1, Math.min(5000, Number(options.limit || 500)));
  const clauses = ["event_time >= ?"];
  const params = [cutoff];
  if (options.symbol) {
    clauses.push("asset_symbol = ?");
    params.push(String(options.symbol).replace(/^\$/, "").toUpperCase());
  }
  if (options.chain) {
    clauses.push("chain = ?");
    params.push(String(options.chain).toLowerCase());
  }
  params.push(limit);
  const rows = store.prepare([
    "SELECT * FROM onchain_events",
    "WHERE " + clauses.join(" AND "),
    "ORDER BY event_time DESC LIMIT ?",
  ].join("\n")).all(...params);
  return rows.map((row) => ({
    eventKey: row.event_key,
    provider: row.provider,
    chain: row.chain,
    assetSymbol: row.asset_symbol,
    contractAddress: row.contract_address,
    txHash: row.tx_hash,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    amount: row.amount,
    decimals: row.decimals,
    valueUsd: row.value_usd,
    eventTime: row.event_time,
    payload: (() => { try { return JSON.parse(row.payload_json); } catch { return {}; } })(),
  }));
}

function getOnchainStoreHealth() {
  const store = requireDb();
  return {
    events: store.prepare("SELECT COUNT(*) AS count FROM onchain_events").get().count,
    latestEventAt: store.prepare("SELECT MAX(event_time) AS value FROM onchain_events").get().value || null,
  };
}

module.exports = {
  getOnchainStoreHealth,
  listOnchainEvents,
  normalizeEvent,
  recordOnchainEvents,
};
