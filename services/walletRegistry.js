"use strict";

const { openDatabase } = require("./database");
const { increment } = require("./telemetry");
const {
  enrichWalletQuality,
  isAlchemyEligible,
  calculateWalletQuality,
  monitoringPriority,
} = require("./walletQuality");

const BASE_MIGRATION_ID = "wallet-intelligence-v1";
const MIGRATION_ID = "wallet-watchlist-bulk-v1";
const VALID_CATEGORIES = new Set([
  "smart_money",
  "kol",
  "exchange_deposit",
  "exchange_aggregation",
  "exchange_hot",
  "exchange_cold",
  "exchange_treasury",
  "market_maker",
  "whale",
  "fund",
  "treasury",
  "deployer",
  "team",
  "protocol",
  "listing_watch",
  "tracked_wallet",
]);
const VALID_VERIFICATION_STATUSES = new Set([
  "unverified",
  "pending",
  "rejected",
  "provider_classified",
  "manual_approved",
  "verified",
  "official",
]);
const VALID_ROLES = new Set([
  "deposit",
  "aggregation",
  "hot",
  "cold",
  "treasury",
  "market_maker",
  "listing_watch",
]);
const PRIORITY_EXCHANGES = new Set([
  "upbit", "binance", "bitget", "bithumb", "okx", "bybit", "coinbase", "kraken", "gate", "kucoin", "mexc", "htx",
]);

let db = null;

function now() {
  return Date.now();
}

function normalizeChain(value) {
  const chain = String(value || "").trim().toLowerCase();
  const aliases = {
    eth: "ethereum",
    mainnet: "ethereum",
    arb: "arbitrum",
    op: "optimism",
    matic: "polygon",
    binance: "bsc",
    "bnb smart chain": "bsc",
    sol: "solana",
  };
  return aliases[chain] || chain;
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function sanitizeUrl(value) {
  const url = String(value || "").trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function clampConfidence(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed > 1 ? parsed / 100 : parsed));
}

function safeJson(value, fallback = {}) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function initializeWalletRegistry(database = openDatabase()) {
  db = database;
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS perpsia_schema_migrations (migration_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const applied = db.prepare("SELECT 1 FROM perpsia_schema_migrations WHERE migration_id = ?").get(BASE_MIGRATION_ID);
  if (!applied) {
    const migrate = db.transaction(() => {
      db.exec([
        "CREATE TABLE IF NOT EXISTS exchange_wallet_clusters (",
        "id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "exchange TEXT NOT NULL,",
        "chain TEXT NOT NULL,",
        "cluster_key TEXT NOT NULL,",
        "label TEXT,",
        "source TEXT NOT NULL,",
        "source_url TEXT,",
        "verification_status TEXT NOT NULL DEFAULT 'unverified',",
        "source_confidence REAL NOT NULL DEFAULT 0,",
        "enabled INTEGER NOT NULL DEFAULT 1,",
        "notes TEXT,",
        "first_seen_at INTEGER NOT NULL,",
        "last_verified_at INTEGER,",
        "updated_at INTEGER NOT NULL,",
        "UNIQUE(exchange, chain, cluster_key)",
        ");",
        "CREATE TABLE IF NOT EXISTS wallet_registry (",
        "id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "address TEXT NOT NULL,",
        "chain TEXT NOT NULL,",
        "label TEXT,",
        "category TEXT NOT NULL,",
        "source TEXT NOT NULL,",
        "source_url TEXT,",
        "source_confidence REAL NOT NULL DEFAULT 0,",
        "verification_status TEXT NOT NULL DEFAULT 'unverified',",
        "enabled INTEGER NOT NULL DEFAULT 1,",
        "notes TEXT,",
        "public_identity_reference TEXT,",
        "approval_status TEXT,",
        "exchange TEXT,",
        "role TEXT,",
        "exchange_cluster_id INTEGER,",
        "first_seen_at INTEGER NOT NULL,",
        "last_seen_at INTEGER,",
        "last_verified_at INTEGER,",
        "updated_at INTEGER NOT NULL,",
        "alchemy_subscribed INTEGER NOT NULL DEFAULT 0,",
        "alchemy_webhook_id TEXT,",
        "last_alchemy_sync_at INTEGER,",
        "alchemy_sync_status TEXT,",
        "alchemy_sync_error TEXT,",
        "metadata_json TEXT NOT NULL DEFAULT '{}',",
        "UNIQUE(address, chain),",
        "FOREIGN KEY(exchange_cluster_id) REFERENCES exchange_wallet_clusters(id)",
        ");",
        "CREATE TABLE IF NOT EXISTS wallet_registry_provenance (",
        "id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "wallet_id INTEGER NOT NULL,",
        "source TEXT NOT NULL,",
        "source_key TEXT NOT NULL,",
        "source_url TEXT,",
        "payload_json TEXT NOT NULL DEFAULT '{}',",
        "first_seen_at INTEGER NOT NULL,",
        "last_seen_at INTEGER NOT NULL,",
        "UNIQUE(wallet_id, source, source_key),",
        "FOREIGN KEY(wallet_id) REFERENCES wallet_registry(id) ON DELETE CASCADE",
        ");",
        "CREATE TABLE IF NOT EXISTS wallet_alchemy_sync (",
        "wallet_id INTEGER NOT NULL,",
        "chain TEXT NOT NULL,",
        "alchemy_subscribed INTEGER NOT NULL DEFAULT 0,",
        "alchemy_webhook_id TEXT,",
        "last_alchemy_sync_at INTEGER,",
        "alchemy_sync_status TEXT NOT NULL DEFAULT 'pending',",
        "alchemy_sync_error TEXT,",
        "updated_at INTEGER NOT NULL,",
        "PRIMARY KEY(wallet_id, chain),",
        "FOREIGN KEY(wallet_id) REFERENCES wallet_registry(id) ON DELETE CASCADE",
        ");",
        "CREATE TABLE IF NOT EXISTS wallet_event_links (",
        "event_key TEXT NOT NULL,",
        "wallet_id INTEGER NOT NULL,",
        "relation TEXT NOT NULL,",
        "token TEXT,",
        "direction TEXT,",
        "metadata_json TEXT NOT NULL DEFAULT '{}',",
        "created_at INTEGER NOT NULL,",
        "PRIMARY KEY(event_key, wallet_id, relation),",
        "FOREIGN KEY(wallet_id) REFERENCES wallet_registry(id) ON DELETE CASCADE",
        ");",
        "CREATE TABLE IF NOT EXISTS listing_watch_events (",
        "id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "event_key TEXT NOT NULL UNIQUE,",
        "symbol TEXT NOT NULL,",
        "contract_address TEXT,",
        "chain TEXT NOT NULL,",
        "exchange TEXT NOT NULL,",
        "level TEXT NOT NULL,",
        "event_type TEXT NOT NULL DEFAULT 'LISTING_WATCH',",
        "observations_json TEXT NOT NULL DEFAULT '[]',",
        "sources_json TEXT NOT NULL DEFAULT '[]',",
        "official_confirmation INTEGER NOT NULL DEFAULT 0,",
        "first_seen_at INTEGER NOT NULL,",
        "last_seen_at INTEGER NOT NULL,",
        "updated_at INTEGER NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS alchemy_webhook_registry (",
        "network TEXT PRIMARY KEY,",
        "webhook_id TEXT NOT NULL,",
        "webhook_url TEXT,",
        "managed_by_perpsia INTEGER NOT NULL DEFAULT 0,",
        "last_sync_at INTEGER,",
        "sync_status TEXT NOT NULL DEFAULT 'pending',",
        "sync_error TEXT,",
        "updated_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_wallet_registry_address ON wallet_registry(address);",
        "CREATE INDEX IF NOT EXISTS idx_wallet_registry_chain ON wallet_registry(chain);",
        "CREATE INDEX IF NOT EXISTS idx_wallet_registry_category ON wallet_registry(category);",
        "CREATE INDEX IF NOT EXISTS idx_wallet_registry_exchange ON wallet_registry(exchange);",
        "CREATE INDEX IF NOT EXISTS idx_wallet_registry_enabled ON wallet_registry(enabled);",
        "CREATE INDEX IF NOT EXISTS idx_wallet_registry_source ON wallet_registry(source);",
        "CREATE INDEX IF NOT EXISTS idx_wallet_events_wallet ON wallet_event_links(wallet_id, created_at);",
        "CREATE INDEX IF NOT EXISTS idx_listing_watch_symbol ON listing_watch_events(symbol, chain, last_seen_at);",
        "CREATE INDEX IF NOT EXISTS idx_listing_watch_exchange ON listing_watch_events(exchange, level);",
      ].join("\n"));
      db.prepare("INSERT INTO perpsia_schema_migrations (migration_id, applied_at) VALUES (?, ?)").run(BASE_MIGRATION_ID, now());
    });
    migrate();
  }
  const bulkApplied = db.prepare("SELECT 1 FROM perpsia_schema_migrations WHERE migration_id = ?").get(MIGRATION_ID);
  if (!bulkApplied) {
    const migrateBulk = db.transaction(() => {
      const columns = new Set(db.pragma("table_info(wallet_registry)").map((column) => column.name));
      const additions = [
        ["wallet_quality_score", "REAL"],
        ["wallet_quality_tier", "TEXT"],
        ["monitoring_priority", "INTEGER NOT NULL DEFAULT 0"],
        ["performance_metadata_json", "TEXT NOT NULL DEFAULT '{}'"],
        ["last_gmgn_refresh_at", "INTEGER"],
        ["source_reliability", "REAL NOT NULL DEFAULT 0"],
        ["alchemy_eligible", "INTEGER NOT NULL DEFAULT 0"],
      ];
      for (const [name, type] of additions) {
        if (!columns.has(name)) db.exec(`ALTER TABLE wallet_registry ADD COLUMN ${name} ${type}`);
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_wallet_registry_priority ON wallet_registry(monitoring_priority DESC, enabled)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_wallet_registry_quality ON wallet_registry(wallet_quality_tier, wallet_quality_score)");
      db.prepare("INSERT INTO perpsia_schema_migrations (migration_id, applied_at) VALUES (?, ?)").run(MIGRATION_ID, now());
    });
    migrateBulk();
  }
  // Recompute derived eligibility/priority for records created before this migration.
  db.prepare("SELECT * FROM wallet_registry").all().forEach((row) => {
    const qualityTier = row.wallet_quality_tier || "UNASSESSED";
    const priority = monitoringPriority({ category: row.category, role: row.role, exchange: row.exchange, verificationStatus: row.verification_status, qualityTier });
    const eligible = isAlchemyEligible(row.chain, row.address) ? 1 : 0;
    if (row.monitoring_priority !== priority || row.alchemy_eligible !== eligible) {
      db.prepare("UPDATE wallet_registry SET monitoring_priority = ?, alchemy_eligible = ? WHERE id = ?").run(priority, eligible, row.id);
    }
  });
  return db;
}

function requireDb() {
  return db || initializeWalletRegistry();
}

function rowToWallet(row) {
  if (!row) return null;
  return {
    id: row.id,
    address: row.address,
    chain: row.chain,
    label: row.label,
    category: row.category,
    source: row.source,
    sourceUrl: row.source_url,
    sourceConfidence: Number(row.source_confidence || 0),
    sourceReliability: Number(row.source_reliability || 0),
    verificationStatus: row.verification_status,
    enabled: Boolean(row.enabled),
    notes: row.notes,
    publicIdentityReference: row.public_identity_reference,
    approvalStatus: row.approval_status,
    exchange: row.exchange,
    role: row.role,
    exchangeClusterId: row.exchange_cluster_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastVerifiedAt: row.last_verified_at,
    updatedAt: row.updated_at,
    qualityScore: row.wallet_quality_score === null || row.wallet_quality_score === undefined ? null : Number(row.wallet_quality_score),
    qualityTier: row.wallet_quality_tier || "UNASSESSED",
    monitoringPriority: Number(row.monitoring_priority || 0),
    performanceMetadata: parseJson(row.performance_metadata_json, {}),
    lastGmgnRefreshAt: row.last_gmgn_refresh_at,
    alchemyEligible: Boolean(row.alchemy_eligible),
    alchemySubscribed: Boolean(row.alchemy_subscribed),
    alchemyWebhookId: row.alchemy_webhook_id,
    lastAlchemySyncAt: row.last_alchemy_sync_at,
    alchemySyncStatus: row.alchemy_sync_status,
    alchemySyncError: row.alchemy_sync_error,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeInput(input = {}) {
  const address = normalizeAddress(input.address || input.wallet || input.walletAddress);
  const chain = normalizeChain(input.chain || input.network);
  const category = String(input.category || "tracked_wallet").trim().toLowerCase();
  const verificationStatus = String(input.verificationStatus || input.verification_status || "unverified").trim().toLowerCase();
  const role = input.role ? normalizeRole(input.role) : null;
  if (!address || !chain) throw new Error("Wallet address and chain are required.");
  if (!isValidAddress(chain, address)) throw new Error("Wallet address format is invalid for chain " + chain + ".");
  if (!VALID_CATEGORIES.has(category)) throw new Error("Unsupported wallet category: " + category);
  if (!VALID_VERIFICATION_STATUSES.has(verificationStatus)) throw new Error("Unsupported wallet verification status: " + verificationStatus);
  if (role && !VALID_ROLES.has(role)) throw new Error("Unsupported exchange wallet role: " + role);
  return {
    address,
    chain,
    label: input.label ? String(input.label).trim().slice(0, 200) : null,
    category,
    source: String(input.source || "manual").trim().slice(0, 80) || "manual",
    sourceUrl: sanitizeUrl(input.sourceUrl || input.source_url),
    sourceConfidence: clampConfidence(input.sourceConfidence ?? input.source_confidence),
    verificationStatus,
    enabled: input.enabled !== false && verificationStatus !== "rejected",
    notes: input.notes ? String(input.notes).trim().slice(0, 2000) : null,
    publicIdentityReference: input.publicIdentityReference ? String(input.publicIdentityReference).trim().slice(0, 300) : null,
    approvalStatus: input.approvalStatus ? String(input.approvalStatus).trim().slice(0, 80) : null,
    exchange: input.exchange ? String(input.exchange).trim().slice(0, 80) : null,
    role,
    qualityMetrics: input.qualityMetrics || input.quality_metrics || input.performanceMetadata || input.performance_metadata || {},
    qualityScore: input.qualityScore ?? input.walletQualityScore ?? null,
    qualityTier: input.qualityTier || input.walletQualityTier || null,
    monitoringPriority: input.monitoringPriority ?? input.priority ?? null,
    performanceMetadata: input.performanceMetadata || input.performance_metadata || {},
    lastGmgnRefreshAt: input.lastGmgnRefreshAt || input.last_gmgn_refresh_at || null,
    sourceReliability: clampConfidence(input.sourceReliability ?? input.source_reliability ?? input.sourceConfidence ?? input.source_confidence),
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
}

function isValidAddress(chain, address) {
  if (["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc"].includes(chain)) return /^0x[a-f0-9]{40}$/i.test(address);
  if (chain === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  return address.length >= 4 && !/\s/.test(address);
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  const aliases = {
    exchange_deposit: "deposit",
    exchange_aggregation: "aggregation",
    exchange_hot: "hot",
    exchange_cold: "cold",
    exchange_treasury: "treasury",
  };
  return aliases[role] || role;
}

function normalizeExchange(value) {
  const exchange = String(value || "").trim();
  const key = exchange.toLowerCase();
  const aliases = { "binance.com": "Binance", "upbit.com": "Upbit", "coinbase exchange": "Coinbase", "gate.io": "Gate", "kucoin.com": "KuCoin" };
  const normalized = aliases[key] || exchange;
  if (!PRIORITY_EXCHANGES.has(normalized.toLowerCase())) throw new Error("Unsupported exchange name: " + exchange);
  return normalized;
}

function verificationRank(status) {
  return {
    rejected: -1,
    unverified: 0,
    pending: 1,
    provider_classified: 2,
    verified: 3,
    official: 4,
    manual_approved: 5,
  }[String(status || "").toLowerCase()] ?? 0;
}

function parseStoredObject(value) {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function upsertWallet(input = {}) {
  const normalized = normalizeInput(input);
  const quality = enrichWalletQuality({ ...input, ...normalized }, { now: now() });
  const item = {
    ...normalized,
    qualityMetrics: quality.metrics,
    qualityScore: quality.score,
    qualityTier: quality.tier,
    monitoringPriority: normalized.monitoringPriority === null ? quality.monitoringPriority : Number(normalized.monitoringPriority),
    performanceMetadata: normalized.performanceMetadata && Object.keys(normalized.performanceMetadata).length ? normalized.performanceMetadata : quality.metrics,
    lastGmgnRefreshAt: normalized.lastGmgnRefreshAt || (normalized.source === "gmgn" ? now() : null),
  };
  item.monitoringPriority = monitoringPriority(item);
  const store = requireDb();
  const timestamp = now();
  const existing = store.prepare("SELECT * FROM wallet_registry WHERE address = ? AND chain = ?").get(item.address, item.chain);
  if (!existing) {
    const result = store.prepare([
      "INSERT INTO wallet_registry (address, chain, label, category, source, source_url, source_confidence, source_reliability, verification_status, enabled, notes, public_identity_reference, approval_status, exchange, role, first_seen_at, last_seen_at, last_verified_at, updated_at, wallet_quality_score, wallet_quality_tier, monitoring_priority, performance_metadata_json, last_gmgn_refresh_at, alchemy_eligible, metadata_json)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join("\n")).run(
      item.address, item.chain, item.label, item.category, item.source, item.sourceUrl,
      item.sourceConfidence, item.sourceReliability, item.verificationStatus, item.enabled ? 1 : 0, item.notes,
      item.publicIdentityReference, item.approvalStatus, item.exchange, item.role,
      timestamp, timestamp, ["verified", "official", "manual_approved"].includes(item.verificationStatus) ? timestamp : null,
      timestamp, item.qualityScore, item.qualityTier, item.monitoringPriority, safeJson(item.performanceMetadata, {}), item.lastGmgnRefreshAt,
      isAlchemyEligible(item.chain, item.address) ? 1 : 0, safeJson(item.metadata, {}),
    );
    const wallet = rowToWallet(store.prepare("SELECT * FROM wallet_registry WHERE id = ?").get(result.lastInsertRowid));
    recordProvenance(wallet.id, item.source, input.sourceKey || item.source + ":" + item.address, item.sourceUrl, input.payload || input);
    return { created: true, updated: false, wallet };
  }
  const existingStatus = String(existing.verification_status || "unverified").toLowerCase();
  const incomingIsStronger = verificationRank(item.verificationStatus) > verificationRank(existingStatus);
  const effectiveStatus = incomingIsStronger ? item.verificationStatus : existingStatus;
  const preserveExistingIdentity = verificationRank(existingStatus) >= verificationRank("manual_approved") && !incomingIsStronger;
  const effectiveCategory = preserveExistingIdentity ? existing.category : item.category;
  const effectiveLabel = preserveExistingIdentity ? existing.label : item.label;
  const effectiveEnabled = effectiveStatus === "rejected" ? false : preserveExistingIdentity ? Boolean(existing.enabled) : item.enabled;
  const mergedMetadata = { ...parseStoredObject(existing.metadata_json), ...item.metadata };
  const mergedPerformance = { ...parseStoredObject(existing.performance_metadata_json), ...item.performanceMetadata };
  const effectiveQualityScore = item.qualityScore === null ? (existing.wallet_quality_score ?? null) : item.qualityScore;
  const effectiveQualityTier = item.qualityScore === null ? (existing.wallet_quality_tier || "UNASSESSED") : item.qualityTier;
  const effectivePriority = monitoringPriority({ ...item, category: effectiveCategory, qualityTier: effectiveQualityTier, verificationStatus: effectiveStatus, enabled: effectiveEnabled });
  store.prepare([
    "UPDATE wallet_registry SET label = COALESCE(?, label), category = ?, source = CASE WHEN ? > ? THEN ? ELSE source END, source_url = CASE WHEN ? > ? THEN COALESCE(?, source_url) ELSE source_url END, source_confidence = MAX(source_confidence, ?), source_reliability = MAX(source_reliability, ?),",
    "verification_status = ?, enabled = ?, notes = COALESCE(?, notes), public_identity_reference = COALESCE(?, public_identity_reference),",
    "approval_status = COALESCE(?, approval_status), exchange = COALESCE(?, exchange), role = COALESCE(?, role), last_seen_at = ?,",
    "last_verified_at = CASE WHEN ? IN ('verified', 'official', 'manual_approved') THEN ? ELSE last_verified_at END, updated_at = ?, wallet_quality_score = ?, wallet_quality_tier = ?, monitoring_priority = ?, performance_metadata_json = ?, last_gmgn_refresh_at = COALESCE(?, last_gmgn_refresh_at), alchemy_eligible = ?, metadata_json = ? WHERE id = ?",
  ].join("\n")).run(
    effectiveLabel, effectiveCategory, verificationRank(item.verificationStatus), verificationRank(existingStatus), item.source,
    verificationRank(item.verificationStatus), verificationRank(existingStatus), item.sourceUrl, item.sourceConfidence, item.sourceReliability,
    effectiveStatus, effectiveEnabled ? 1 : 0, item.notes, item.publicIdentityReference,
    item.approvalStatus, item.exchange, item.role, timestamp,
    effectiveStatus, timestamp, timestamp, effectiveQualityScore, effectiveQualityTier, effectivePriority, safeJson(mergedPerformance, {}), item.lastGmgnRefreshAt,
    isAlchemyEligible(item.chain, item.address) ? 1 : 0, safeJson(mergedMetadata, {}), existing.id,
  );
  const wallet = rowToWallet(store.prepare("SELECT * FROM wallet_registry WHERE id = ?").get(existing.id));
  recordProvenance(wallet.id, item.source, input.sourceKey || item.source + ":" + item.address, item.sourceUrl, input.payload || input);
  return { created: false, updated: true, wallet };
}

function recordProvenance(walletId, source, sourceKey, sourceUrl, payload) {
  const store = requireDb();
  const timestamp = now();
  store.prepare([
    "INSERT INTO wallet_registry_provenance (wallet_id, source, source_key, source_url, payload_json, first_seen_at, last_seen_at)",
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
    "ON CONFLICT(wallet_id, source, source_key) DO UPDATE SET source_url = excluded.source_url, payload_json = excluded.payload_json, last_seen_at = excluded.last_seen_at",
  ].join("\n")).run(walletId, String(source || "unknown"), String(sourceKey || "unknown"), sanitizeUrl(sourceUrl), safeJson(payload, {}), timestamp, timestamp);
}

function getWallet(id) {
  return rowToWallet(requireDb().prepare("SELECT * FROM wallet_registry WHERE id = ?").get(Number(id)));
}

function getWalletByAddress(chain, address) {
  return rowToWallet(requireDb().prepare("SELECT * FROM wallet_registry WHERE chain = ? AND address = ?").get(normalizeChain(chain), normalizeAddress(address)));
}

function listWallets(filters = {}) {
  const where = [];
  const params = [];
  if (filters.chain) { where.push("chain = ?"); params.push(normalizeChain(filters.chain)); }
  if (filters.address) { where.push("address = ?"); params.push(normalizeAddress(filters.address)); }
  if (filters.exchange) { where.push("exchange = ?"); params.push(String(filters.exchange)); }
  if (filters.source) { where.push("source = ?"); params.push(String(filters.source)); }
  if (filters.verificationStatus) { where.push("verification_status = ?"); params.push(String(filters.verificationStatus).toLowerCase()); }
  if (filters.enabled !== undefined) { where.push("enabled = ?"); params.push(filters.enabled ? 1 : 0); }
  if (filters.qualityTier) { where.push("wallet_quality_tier = ?"); params.push(String(filters.qualityTier).toUpperCase()); }
  if (filters.minPriority !== undefined) { where.push("monitoring_priority >= ?"); params.push(Math.max(0, Number(filters.minPriority) || 0)); }
  if (filters.alchemyEligible !== undefined) { where.push("alchemy_eligible = ?"); params.push(filters.alchemyEligible ? 1 : 0); }
  const categories = Array.isArray(filters.categories) ? filters.categories : filters.category ? [filters.category] : [];
  if (categories.length) {
    const normalized = categories.map((value) => String(value).toLowerCase()).filter((value) => VALID_CATEGORIES.has(value));
    if (!normalized.length) return [];
    where.push("category IN (" + normalized.map(() => "?").join(",") + ")");
    params.push(...normalized);
  }
  const query = "SELECT * FROM wallet_registry" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY updated_at DESC" + (filters.limit ? " LIMIT " + Math.max(1, Math.min(10000, Number(filters.limit))) : "");
  return requireDb().prepare(query).all(...params).map(rowToWallet);
}

function setWalletEnabled(id, enabled) {
  const result = requireDb().prepare("UPDATE wallet_registry SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now(), Number(id));
  return { changed: result.changes > 0, wallet: getWallet(id) };
}

function relabelWallet(id, changes = {}) {
  const current = getWallet(id);
  if (!current) throw new Error("Wallet not found.");
  return upsertWallet({ ...current, ...changes, id, address: current.address, chain: current.chain, source: changes.source || "manual", verificationStatus: changes.verificationStatus || current.verificationStatus, sourceKey: "manual-relabel:" + id });
}

function approveWallet(id, notes) {
  const result = requireDb().prepare("UPDATE wallet_registry SET verification_status = 'manual_approved', approval_status = 'approved', notes = COALESCE(?, notes), last_verified_at = ?, updated_at = ? WHERE id = ?").run(notes || null, now(), now(), Number(id));
  return { changed: result.changes > 0, wallet: getWallet(id) };
}

function importGmgnWallets(records = [], options = {}) {
  const acceptedCategories = new Set(["smart_money", "kol", "whale", "tracked_wallet"]);
  return importRecords(records, (record) => {
    const rawCategory = String(record.category || record.walletCategory || record.classification || record.tag || "").toLowerCase().replace(/[ -]+/g, "_");
    const category = {
      smartmoney: "smart_money",
      smart_degen: "smart_money",
      smart_money: "smart_money",
      profitable_trader: "smart_money",
      profitable_traders: "smart_money",
      ranked_trader: "smart_money",
      ranked_traders: "smart_money",
      ct: "kol",
      influencer: "kol",
    }[rawCategory] || rawCategory;
    if (!acceptedCategories.has(category)) throw new Error("GMGN record has no explicit supported classification.");
    return {
      ...record,
      address: record.address || record.walletAddress || record.wallet_address,
      category,
      source: "gmgn",
      sourceKey: record.sourceKey || options.sourceKey || "gmgn:" + (record.address || record.walletAddress || record.wallet_address || "unknown"),
      verificationStatus: record.verificationStatus || "provider_classified",
      sourceUrl: record.sourceUrl || options.sourceUrl || "https://gmgn.ai/",
      lastGmgnRefreshAt: record.lastGmgnRefreshAt || now(),
      qualityMetrics: record.qualityMetrics || record.quality_metrics || record.performanceMetadata || record,
      payload: record,
    };
  });
}

function importManualWallet(input = {}) {
  const approved = input.approvalStatus === "approved" || input.verificationStatus === "manual_approved";
  return upsertWallet({ ...input, source: input.source || "manual", verificationStatus: approved ? "manual_approved" : "pending", sourceKey: input.sourceKey || "manual:" + input.address, payload: input });
}

function importExchangeWallets(records = []) {
  return importRecords(records, (record) => {
    const verificationStatus = String(record.verificationStatus || record.verification_status || "").toLowerCase();
    if (!["pending", "verified", "official", "manual_approved", "rejected"].includes(verificationStatus)) throw new Error("Exchange wallet requires official, verified, manual_approved, pending, or rejected provenance.");
    const sourceUrl = sanitizeUrl(record.sourceUrl || record.source_url);
    if (!sourceUrl) throw new Error("Exchange wallet requires a valid provenance URL.");
    const exchange = normalizeExchange(record.exchange);
    if (!exchange) throw new Error("Exchange name is required.");
    const role = normalizeRole(record.role || "listing_watch");
    if (!VALID_ROLES.has(role)) throw new Error("Unsupported exchange wallet role.");
    const category = role === "market_maker" || role === "listing_watch" ? role : "exchange_" + role;
    return {
      ...record,
      exchange,
      role,
      category: VALID_CATEGORIES.has(category) ? category : "listing_watch",
      sourceUrl,
      source: record.source || "verified_exchange",
      verificationStatus,
      enabled: verificationStatus === "pending" || verificationStatus === "rejected" ? false : record.enabled !== false,
      sourceKey: record.sourceKey || exchange + ":" + role + ":" + (record.address || record.walletAddress || "unknown"),
      payload: record,
    };
  });
}

function importCategorizedWallets(records = [], category, options = {}) {
  const allowed = new Set(["kol", "market_maker", "fund", "treasury", "team", "protocol"]);
  if (!allowed.has(category)) throw new Error("Unsupported curated wallet category: " + category);
  return importRecords(records, (record) => prepareCategorizedRecord(record, category, options));
}

function prepareCategorizedRecord(record, category, options = {}) {
  const sourceUrl = sanitizeUrl(record.sourceUrl || record.source_url);
  if (!sourceUrl) throw new Error("Curated wallet requires a valid provenance URL.");
  const verificationStatus = String(record.verificationStatus || record.verification_status || "pending").toLowerCase();
  if (!["pending", "verified", "official", "manual_approved", "rejected"].includes(verificationStatus)) throw new Error("Unsupported verification status.");
  if (category === "kol" && !["manual_approved", "verified", "official"].includes(verificationStatus)) throw new Error("KOL wallet requires verified or manual_approved provenance.");
  return {
    ...record,
    category,
    source: record.source || options.source || "manual_curated",
    sourceUrl,
    verificationStatus,
    enabled: verificationStatus === "pending" || verificationStatus === "rejected" ? false : record.enabled !== false,
    sourceKey: record.sourceKey || category + ":" + (record.address || record.walletAddress || "unknown"),
    payload: record,
  };
}

function importKols(records = []) {
  return importCategorizedWallets(records, "kol", { source: "manual_kol" });
}

function importFunds(records = []) {
  return importRecords(records, (record) => {
    const category = String(record.category || "").toLowerCase();
    if (!["market_maker", "fund", "treasury", "team", "protocol"].includes(category)) throw new Error("Fund dataset requires an explicit supported category.");
    return prepareCategorizedRecord(record, category, { source: "manual_funds" });
  });
}

function importRecords(records, prepare) {
  const result = { created: [], updated: [], skipped: [], rejected: [], duplicates: [], imported: [], count: 0 };
  const seen = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    result.count += 1;
    try {
      const prepared = prepare(record || {});
      const chain = normalizeChain(prepared.chain || prepared.network);
      const address = normalizeAddress(prepared.address || prepared.walletAddress || prepared.wallet_address);
      const key = chain + ":" + address;
      if (seen.has(key)) {
        result.duplicates.push({ record, key });
        result.skipped.push({ record, reason: "duplicate in this import batch" });
        increment("wallet_imports_total", { source: prepared.source || "unknown", status: "duplicate" });
        continue;
      }
      seen.add(key);
      const upserted = upsertWallet(prepared);
      result.imported.push(upserted.wallet);
      result[upserted.created ? "created" : "updated"].push(upserted.wallet);
      increment("wallet_imports_total", { source: upserted.wallet.source || "unknown", status: upserted.created ? "created" : "updated" });
      increment("wallet_watchlist_total", { category: upserted.wallet.category || "unknown", chain: upserted.wallet.chain || "unknown" });
      increment("wallet_quality_tier_total", { tier: upserted.wallet.qualityTier || "UNASSESSED" });
      increment("wallet_priority_total", { priority: String(upserted.wallet.monitoringPriority || 0) });
      if (["official", "verified", "manual_approved"].includes(upserted.wallet.verificationStatus) && upserted.wallet.exchange) {
        increment("exchange_wallets_verified_total", { exchange: upserted.wallet.exchange, role: upserted.wallet.role || "unknown" });
      }
    } catch (error) {
      result.rejected.push({ record, reason: error.message });
      increment("wallet_import_rejections_total", { source: record?.source || "unknown", reason: error.message.slice(0, 80) });
    }
  }
  return result;
}

function linkWalletEvent(eventKey, walletId, relation, fields = {}) {
  if (!eventKey || !walletId || !relation) return false;
  const result = requireDb().prepare([
    "INSERT OR IGNORE INTO wallet_event_links (event_key, wallet_id, relation, token, direction, metadata_json, created_at)",
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ].join("\n")).run(String(eventKey), Number(walletId), String(relation), fields.token || null, fields.direction || null, safeJson(fields.metadata || {}, {}), now());
  return result.changes > 0;
}

function upsertAlchemySync(walletId, chain, fields = {}) {
  const timestamp = now();
  const result = requireDb().prepare([
    "INSERT INTO wallet_alchemy_sync (wallet_id, chain, alchemy_subscribed, alchemy_webhook_id, last_alchemy_sync_at, alchemy_sync_status, alchemy_sync_error, updated_at)",
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "ON CONFLICT(wallet_id, chain) DO UPDATE SET alchemy_subscribed = excluded.alchemy_subscribed, alchemy_webhook_id = excluded.alchemy_webhook_id, last_alchemy_sync_at = excluded.last_alchemy_sync_at, alchemy_sync_status = excluded.alchemy_sync_status, alchemy_sync_error = excluded.alchemy_sync_error, updated_at = excluded.updated_at",
  ].join("\n")).run(Number(walletId), normalizeChain(chain), fields.alchemySubscribed ? 1 : 0, fields.alchemyWebhookId || null, fields.lastAlchemySyncAt || timestamp, fields.alchemySyncStatus || "synced", fields.alchemySyncError || null, timestamp);
  requireDb().prepare("UPDATE wallet_registry SET alchemy_subscribed = ?, alchemy_webhook_id = ?, last_alchemy_sync_at = ?, alchemy_sync_status = ?, alchemy_sync_error = ?, updated_at = ? WHERE id = ?").run(fields.alchemySubscribed ? 1 : 0, fields.alchemyWebhookId || null, fields.lastAlchemySyncAt || timestamp, fields.alchemySyncStatus || "synced", fields.alchemySyncError || null, timestamp, Number(walletId));
  return result.changes > 0;
}

function listAlchemySync(filters = {}) {
  const rows = requireDb().prepare("SELECT s.*, w.address, w.chain AS wallet_chain, w.category, w.exchange, w.enabled FROM wallet_alchemy_sync s JOIN wallet_registry w ON w.id = s.wallet_id" + (filters.chain ? " WHERE s.chain = ?" : "") + " ORDER BY s.updated_at DESC").all(...(filters.chain ? [normalizeChain(filters.chain)] : []));
  return rows.map((row) => ({ ...row, alchemySubscribed: Boolean(row.alchemy_subscribed), enabled: Boolean(row.enabled) }));
}

function upsertAlchemyWebhook(network, fields = {}) {
  const timestamp = now();
  requireDb().prepare([
    "INSERT INTO alchemy_webhook_registry (network, webhook_id, webhook_url, managed_by_perpsia, last_sync_at, sync_status, sync_error, updated_at)",
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "ON CONFLICT(network) DO UPDATE SET webhook_id = excluded.webhook_id, webhook_url = excluded.webhook_url, managed_by_perpsia = excluded.managed_by_perpsia, last_sync_at = excluded.last_sync_at, sync_status = excluded.sync_status, sync_error = excluded.sync_error, updated_at = excluded.updated_at",
  ].join("\n")).run(normalizeChain(network), String(fields.webhookId), fields.webhookUrl || null, fields.managedByPerpsia ? 1 : 0, fields.lastSyncAt || timestamp, fields.syncStatus || "synced", fields.syncError || null, timestamp);
}

function listAlchemyWebhooks() {
  return requireDb().prepare("SELECT * FROM alchemy_webhook_registry ORDER BY network").all().map((row) => ({ ...row, managedByPerpsia: Boolean(row.managed_by_perpsia) }));
}

function getRegistryHealth() {
  const store = requireDb();
  const total = store.prepare("SELECT COUNT(*) AS count FROM wallet_registry").get().count;
  const enabled = store.prepare("SELECT COUNT(*) AS count FROM wallet_registry WHERE enabled = 1").get().count;
  const byCategory = Object.fromEntries(store.prepare("SELECT category, COUNT(*) AS count FROM wallet_registry WHERE enabled = 1 GROUP BY category").all().map((row) => [row.category, row.count]));
  const byChain = Object.fromEntries(store.prepare("SELECT chain, COUNT(*) AS count FROM wallet_registry WHERE enabled = 1 GROUP BY chain").all().map((row) => [row.chain, row.count]));
  const byExchange = Object.fromEntries(store.prepare("SELECT exchange, COUNT(*) AS count FROM wallet_registry WHERE enabled = 1 AND exchange IS NOT NULL GROUP BY exchange").all().map((row) => [row.exchange, row.count]));
  const bySource = Object.fromEntries(store.prepare("SELECT source, COUNT(*) AS count FROM wallet_registry WHERE enabled = 1 GROUP BY source").all().map((row) => [row.source, row.count]));
  const qualityTiers = Object.fromEntries(store.prepare("SELECT COALESCE(wallet_quality_tier, 'UNASSESSED') AS tier, COUNT(*) AS count FROM wallet_registry GROUP BY COALESCE(wallet_quality_tier, 'UNASSESSED')").all().map((row) => [row.tier, row.count]));
  const pending = store.prepare("SELECT COUNT(*) AS count FROM wallet_registry WHERE verification_status = 'pending'").get().count;
  const rejected = store.prepare("SELECT COUNT(*) AS count FROM wallet_registry WHERE verification_status = 'rejected'").get().count;
  const eligible = store.prepare("SELECT COUNT(*) AS count FROM wallet_registry WHERE enabled = 1 AND alchemy_eligible = 1").get().count;
  const highestPriority = store.prepare("SELECT COUNT(*) AS count FROM wallet_registry WHERE enabled = 1 AND monitoring_priority >= 90").get().count;
  const sync = store.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN alchemy_subscribed = 1 THEN 1 ELSE 0 END) AS synced, SUM(CASE WHEN alchemy_sync_status = 'error' THEN 1 ELSE 0 END) AS errors, MAX(last_alchemy_sync_at) AS last_sync FROM wallet_alchemy_sync").get();
  const listing = store.prepare("SELECT COUNT(*) AS active, MAX(last_seen_at) AS last_event, COUNT(DISTINCT exchange) AS watched_exchanges FROM listing_watch_events").get();
  const gmgn = store.prepare("SELECT COUNT(DISTINCT wallet_id) AS imported, MAX(last_seen_at) AS last_import FROM wallet_registry_provenance WHERE source = 'gmgn'").get();
  const exchangeImport = store.prepare("SELECT COUNT(DISTINCT wallet_id) AS imported, MAX(last_seen_at) AS last_import FROM wallet_registry_provenance WHERE source IN ('verified_exchange', 'official_exchange')").get();
  return {
    schemaVersion: MIGRATION_ID,
    totalWallets: total,
    enabledWallets: enabled,
    byCategory,
    byChain,
    byExchange,
    bySource,
    qualityTiers,
    pendingVerification: Number(pending || 0),
    rejectedWallets: Number(rejected || 0),
    alchemyEligibleWallets: Number(eligible || 0),
    highestPriorityWallets: Number(highestPriority || 0),
    watchlist: {
      smartMoney: Number(byCategory.smart_money || 0),
      kol: Number(byCategory.kol || 0),
      exchanges: Object.entries(byCategory).filter(([category]) => category.startsWith("exchange_") || category === "listing_watch").reduce((sum, [, count]) => sum + Number(count || 0), 0),
      funds: Number(byCategory.fund || 0),
      marketMakers: Number(byCategory.market_maker || 0),
    },
    listingWatch: {
      activeWatches: Number(listing.active || 0),
      lastListingWatchEvent: listing.last_event || null,
      watchedExchanges: Number(listing.watched_exchanges || 0),
    },
    gmgn: {
      importedWalletCount: Number(gmgn.imported || 0),
      lastImport: gmgn.last_import || null,
      status: Number(gmgn.imported || 0) > 0 ? "active" : "idle",
    },
    exchangeImport: {
      importedWalletCount: Number(exchangeImport.imported || 0),
      lastImport: exchangeImport.last_import || null,
      status: Number(exchangeImport.imported || 0) > 0 ? "active" : "idle",
    },
    alchemySync: {
      syncedWalletCount: Number(sync.synced || 0),
      eligibleWalletCount: Number(eligible || 0),
      unsyncedWalletCount: Math.max(0, Number(sync.total || 0) - Number(sync.synced || 0)),
      lastSync: sync.last_sync || null,
      syncErrors: Number(sync.errors || 0),
      webhooks: listAlchemyWebhooks(),
    },
  };
}

function recalculateWalletQuality() {
  const store = requireDb();
  const rows = store.prepare("SELECT * FROM wallet_registry").all();
  const update = store.prepare("UPDATE wallet_registry SET wallet_quality_score = ?, wallet_quality_tier = ?, monitoring_priority = ?, performance_metadata_json = ?, alchemy_eligible = ?, updated_at = ? WHERE id = ?");
  const refreshed = [];
  const apply = store.transaction(() => {
    for (const row of rows) {
      const metrics = parseStoredObject(row.performance_metadata_json);
      const quality = calculateWalletQuality(metrics);
      const tier = quality.tier || "UNASSESSED";
      const priority = monitoringPriority({ category: row.category, role: row.role, exchange: row.exchange, verificationStatus: row.verification_status, qualityTier: tier });
      const eligible = isAlchemyEligible(row.chain, row.address) ? 1 : 0;
      update.run(quality.score, tier, priority, safeJson(metrics, {}), eligible, now(), row.id);
      refreshed.push({ id: row.id, qualityScore: quality.score, qualityTier: tier, monitoringPriority: priority });
    }
  });
  apply();
  return refreshed;
}

function listListingWatchEvents(filters = {}) {
  const where = [];
  const params = [];
  if (filters.symbol) { where.push("symbol = ?"); params.push(String(filters.symbol).replace(/^\$/, "").toUpperCase()); }
  if (filters.chain) { where.push("chain = ?"); params.push(normalizeChain(filters.chain)); }
  const rows = requireDb().prepare("SELECT * FROM listing_watch_events" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY last_seen_at DESC" + (filters.limit ? " LIMIT " + Math.min(1000, Math.max(1, Number(filters.limit))) : "")).all(...params);
  return rows.map((row) => ({ ...row, observations: parseJson(row.observations_json, []), sources: parseJson(row.sources_json, []), officialConfirmation: Boolean(row.official_confirmation) }));
}

function upsertListingWatchEvent(event = {}) {
  const timestamp = now();
  const symbol = String(event.symbol || "").replace(/^\$/, "").toUpperCase();
  const eventKey = String(event.eventKey || [symbol, normalizeChain(event.chain), event.exchange, event.contractAddress || "unknown"].join(":"));
  const confirmed = event.officialConfirmation === true && String(event.eventType || "LISTING_WATCH") === "LISTING_CONFIRMED";
  requireDb().prepare([
    "INSERT INTO listing_watch_events (event_key, symbol, contract_address, chain, exchange, level, event_type, observations_json, sources_json, official_confirmation, first_seen_at, last_seen_at, updated_at)",
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "ON CONFLICT(event_key) DO UPDATE SET level = excluded.level, event_type = excluded.event_type, observations_json = excluded.observations_json, sources_json = excluded.sources_json, official_confirmation = excluded.official_confirmation, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at",
  ].join("\n")).run(eventKey, symbol, event.contractAddress || null, normalizeChain(event.chain), String(event.exchange), String(event.level || "LOW"), confirmed ? "LISTING_CONFIRMED" : "LISTING_WATCH", safeJson(event.observations || [], []), safeJson(event.sources || [], []), confirmed ? 1 : 0, timestamp, timestamp, timestamp);
  return listListingWatchEvents({ symbol, chain: event.chain, limit: 1 })[0] || null;
}

module.exports = {
  MIGRATION_ID,
  VALID_CATEGORIES: [...VALID_CATEGORIES],
  VALID_VERIFICATION_STATUSES: [...VALID_VERIFICATION_STATUSES],
  approveWallet,
  getRegistryHealth,
  getWallet,
  getWalletByAddress,
  importExchangeWallets,
  importFunds,
  importGmgnWallets,
  importKols,
  importManualWallet,
  initializeWalletRegistry,
  linkWalletEvent,
  listAlchemySync,
  listAlchemyWebhooks,
  listListingWatchEvents,
  listWallets,
  normalizeAddress,
  normalizeChain,
  normalizeExchange,
  normalizeRole,
  PRIORITY_EXCHANGES: [...PRIORITY_EXCHANGES],
  recalculateWalletQuality,
  relabelWallet,
  setWalletEnabled,
  upsertAlchemySync,
  upsertAlchemyWebhook,
  upsertListingWatchEvent,
  upsertWallet,
};
