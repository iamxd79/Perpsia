"use strict";

const axios = require("axios");
const {
  HORIZONS,
  buildEvidenceSnapshot,
  finiteNumber,
  normalizeDirection,
} = require("./signalQuality");

let db = null;

const DEFAULT_MIN_OBSERVATIONS = 10;
const MAX_SIGNALS_PER_RUN = 100;
const CANDLE_INTERVAL = "1h";

function safeJson(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function round(value, digits = 6) {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Number(parsed.toFixed(digits));
}

function initializeSignalQuality(database) {
  if (!database) throw new Error("Signal quality requires a database handle.");
  db = database;
  db.pragma("journal_mode = WAL");
  db.exec([
    "CREATE TABLE IF NOT EXISTS signal_quality_signals (",
    "id TEXT PRIMARY KEY,",
    "performance_signal_id TEXT,",
    "symbol TEXT NOT NULL,",
    "venue TEXT,",
    "signal_time INTEGER NOT NULL,",
    "direction TEXT NOT NULL,",
    "score REAL,",
    "confidence_score REAL,",
    "lifecycle_state TEXT,",
    "entry_price REAL NOT NULL,",
    "stop_price REAL NOT NULL,",
    "tp1_price REAL NOT NULL,",
    "tp2_price REAL,",
    "market_price REAL,",
    "evidence_json TEXT NOT NULL,",
    "providers_json TEXT NOT NULL,",
    "evidence_groups_json TEXT NOT NULL,",
    "conflicts_json TEXT NOT NULL,",
    "signal_type TEXT NOT NULL,",
    "market_regime TEXT,",
    "source TEXT,",
    "status TEXT NOT NULL DEFAULT 'OPEN',",
    "invalidated_at INTEGER,",
    "invalidation_reason TEXT,",
    "created_at TEXT DEFAULT CURRENT_TIMESTAMP",
    ");",
    "CREATE INDEX IF NOT EXISTS idx_quality_signal_time ON signal_quality_signals(signal_time);",
    "CREATE INDEX IF NOT EXISTS idx_quality_signal_type ON signal_quality_signals(signal_type);",
    "CREATE INDEX IF NOT EXISTS idx_quality_signal_confidence ON signal_quality_signals(confidence_score);",
    "CREATE TABLE IF NOT EXISTS signal_quality_outcomes (",
    "id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "signal_id TEXT NOT NULL,",
    "horizon_key TEXT NOT NULL,",
    "horizon_ms INTEGER NOT NULL,",
    "evaluated_at INTEGER,",
    "status TEXT NOT NULL DEFAULT 'PENDING',",
    "tp1_hit INTEGER,",
    "tp2_hit INTEGER,",
    "stop_hit INTEGER,",
    "mfe_percent REAL,",
    "mae_percent REAL,",
    "time_to_tp1_ms INTEGER,",
    "time_to_tp2_ms INTEGER,",
    "time_to_stop_ms INTEGER,",
    "return_percent REAL,",
    "invalidated INTEGER NOT NULL DEFAULT 0,",
    "invalidation_reason TEXT,",
    "sample_end_time INTEGER,",
    "created_at TEXT DEFAULT CURRENT_TIMESTAMP,",
    "UNIQUE(signal_id, horizon_key),",
    "FOREIGN KEY(signal_id) REFERENCES signal_quality_signals(id)",
    ");",
    "CREATE INDEX IF NOT EXISTS idx_quality_outcome_signal ON signal_quality_outcomes(signal_id);",
    "CREATE INDEX IF NOT EXISTS idx_quality_outcome_status ON signal_quality_outcomes(status);",
    "CREATE INDEX IF NOT EXISTS idx_quality_outcome_horizon ON signal_quality_outcomes(horizon_key, status);",
  ].join(String.fromCharCode(10)));
  return db;
}

function requireDb() {
  if (!db) throw new Error("Signal quality store has not been initialized.");
  return db;
}

function getSignalId(signal, options = {}) {
  if (options.id) return String(options.id);
  if (signal.id) return String(signal.id);
  const seed = [
    String(signal.symbol || "").toUpperCase(),
    String(signal.direction || ""),
    String(signal.signalTime || Date.now()),
  ].join("|");
  return "quality-" + Buffer.from(seed).toString("base64url");
}

function recordQualitySignal(signal, options = {}) {
  if (!signal || !signal.isActionable) return { recorded: false, reason: "not_actionable" };
  const direction = normalizeDirection(signal.direction);
  const entry = finiteNumber(signal.entryPrice ?? signal.entry);
  const stop = finiteNumber(signal.stopPrice ?? signal.stop);
  const tp1 = finiteNumber(signal.tp1Price ?? signal.tp1);
  const tp2 = finiteNumber(signal.tp2Price ?? signal.tp2);
  if (!direction || entry === null || stop === null || tp1 === null) {
    return { recorded: false, reason: "invalid_trade_levels" };
  }

  const snapshot = buildEvidenceSnapshot(signal);
  const id = getSignalId(signal, options);
  const signalTime = finiteNumber(options.signalTime ?? signal.signalTime ?? signal.timestamp) ?? Date.now();
  const marketPrice = finiteNumber(signal.marketPrice ?? signal.price) ?? entry;
  const evidence = {
    structured: signal.evidence || {},
    market: Array.isArray(signal.marketEvidence) ? signal.marketEvidence : [],
    crossSource: signal.crossSource || null,
    divergences: signal.divergences || [],
    liquidation: signal.liquidationFlow || null,
    whale: signal.whaleActivity || null,
    correlation: signal.correlation || null,
  };
  const conflicts = Array.isArray(signal.conflicts) ? signal.conflicts : snapshot.conflicts;
  const result = requireDb().prepare([
    "INSERT OR IGNORE INTO signal_quality_signals (",
    "id, performance_signal_id, symbol, venue, signal_time, direction, score, confidence_score,",
    "lifecycle_state, entry_price, stop_price, tp1_price, tp2_price, market_price,",
    "evidence_json, providers_json, evidence_groups_json, conflicts_json, signal_type, market_regime, source",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(String.fromCharCode(10))).run(
    id,
    options.performanceSignalId ? String(options.performanceSignalId) : null,
    String(signal.symbol || "").replace(/^\$/, "").toUpperCase(),
    String(signal.venue || "Binance"),
    signalTime,
    direction,
    finiteNumber(signal.score),
    snapshot.confidenceScore,
    String(signal.lifecycleState || signal.lifecycleStage || "NEW"),
    entry,
    stop,
    tp1,
    tp2,
    marketPrice,
    safeJson(evidence, {}),
    safeJson(snapshot.providers, []),
    safeJson({
      groups: snapshot.groups,
      combination: snapshot.combination,
      byGroup: snapshot.byGroup,
    }, {}),
    safeJson(conflicts, []),
    snapshot.signalType,
    snapshot.marketRegime,
    options.source || signal.source || "live"
  );
  return {
    recorded: result.changes > 0,
    id,
    status: "OPEN",
    confidenceScore: snapshot.confidenceScore,
    providers: snapshot.providers,
    evidenceGroups: snapshot.groups,
  };
}

function normalizeCandle(candle) {
  if (!candle || typeof candle !== "object") return null;
  const timestamp = finiteNumber(candle.timestamp ?? candle.time ?? candle[0]);
  const high = finiteNumber(candle.high ?? candle[2]);
  const low = finiteNumber(candle.low ?? candle[3]);
  const close = finiteNumber(candle.close ?? candle[4]);
  if ([timestamp, high, low, close].some((value) => value === null)) return null;
  return { timestamp, high, low, close };
}

function parseKlines(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeCandle)
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchHistoricalCandles(signal, options = {}) {
  const httpClient = options.httpClient || axios;
  const baseUrl = options.futuresBaseUrl || process.env.PERFORMANCE_FUTURES_BASE_URL || "https://fapi.binance.com";
  const response = await httpClient.get(baseUrl + "/fapi/v1/klines", {
    params: {
      symbol: String(signal.symbol || "").replace(/^\$/, "").toUpperCase().endsWith("USDT")
        ? String(signal.symbol || "").replace(/^\$/, "").toUpperCase()
        : String(signal.symbol || "").replace(/^\$/, "").toUpperCase() + "USDT",
      interval: CANDLE_INTERVAL,
      startTime: signal.signal_time,
      endTime: Math.min(Date.now(), signal.signal_time + HORIZONS[HORIZONS.length - 1].ms),
      limit: 1500,
    },
    timeout: Number(options.timeoutMs || 12000),
  });
  return parseKlines(response.data);
}

function pnlPercent(direction, entry, price) {
  return direction === "SHORT"
    ? ((entry - price) / entry) * 100
    : ((price - entry) / entry) * 100;
}

function computeOutcome(signal, candles, horizon, now = Date.now()) {
  const endTime = signal.signal_time + horizon.ms;
  const available = (Array.isArray(candles) ? candles : [])
    .map(normalizeCandle)
    .filter(Boolean)
    .filter((candle) => candle.timestamp > signal.signal_time && candle.timestamp <= Math.min(endTime, now))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!available.length) {
    return {
      status: now >= endTime ? "NO_DATA" : "PENDING",
      horizonKey: horizon.key,
      horizonMs: horizon.ms,
      evaluatedAt: now,
      sampleEndTime: null,
    };
  }
  let tp1Hit = false;
  let tp2Hit = false;
  let stopHit = false;
  let timeToTp1 = null;
  let timeToTp2 = null;
  let timeToStop = null;
  let mfe = -Infinity;
  let mae = Infinity;
  let firstExit = null;

  for (const candle of available) {
    const favorable = signal.direction === "LONG"
      ? ((candle.high - signal.entry_price) / signal.entry_price) * 100
      : ((signal.entry_price - candle.low) / signal.entry_price) * 100;
    const adverse = signal.direction === "LONG"
      ? ((candle.low - signal.entry_price) / signal.entry_price) * 100
      : ((signal.entry_price - candle.high) / signal.entry_price) * 100;
    mfe = Math.max(mfe, favorable);
    mae = Math.min(mae, adverse);

    const candleStop = signal.direction === "LONG"
      ? candle.low <= signal.stop_price
      : candle.high >= signal.stop_price;
    const candleTp2 = signal.tp2_price !== null && (
      signal.direction === "LONG" ? candle.high >= signal.tp2_price : candle.low <= signal.tp2_price
    );
    const candleTp1 = signal.direction === "LONG"
      ? candle.high >= signal.tp1_price
      : candle.low <= signal.tp1_price;

    if (candleStop && !stopHit) {
      stopHit = true;
      timeToStop = candle.timestamp - signal.signal_time;
      if (!firstExit) firstExit = { reason: "STOP_HIT", time: candle.timestamp };
    }
    if (candleTp2 && !tp2Hit) {
      tp2Hit = true;
      timeToTp2 = candle.timestamp - signal.signal_time;
      if (!firstExit && !candleStop) firstExit = { reason: "TP2_HIT", time: candle.timestamp };
    }
    if (candleTp1 && !tp1Hit) {
      tp1Hit = true;
      timeToTp1 = candle.timestamp - signal.signal_time;
      if (!firstExit && !candleStop) firstExit = { reason: "TP1_HIT", time: candle.timestamp };
    }
  }

  const last = available[available.length - 1];
  const status = stopHit ? "STOP_HIT" : tp2Hit ? "TP2_HIT" : tp1Hit ? "TP1_HIT" : "NO_EXIT";
  return {
    status,
    horizonKey: horizon.key,
    horizonMs: horizon.ms,
    evaluatedAt: now,
    tp1Hit,
    tp2Hit,
    stopHit,
    mfePercent: round(mfe === -Infinity ? null : mfe),
    maePercent: round(mae === Infinity ? null : mae),
    timeToTp1Ms: timeToTp1,
    timeToTp2Ms: timeToTp2,
    timeToStopMs: timeToStop,
    returnPercent: round(pnlPercent(signal.direction, signal.entry_price, last.close)),
    invalidated: stopHit ? 1 : 0,
    invalidationReason: stopHit ? "STOP_HIT" : null,
    sampleEndTime: last.timestamp,
    firstExit,
  };
}

function saveOutcome(signalId, outcome) {
  const result = requireDb().prepare([
    "INSERT INTO signal_quality_outcomes (",
    "signal_id, horizon_key, horizon_ms, evaluated_at, status, tp1_hit, tp2_hit, stop_hit,",
    "mfe_percent, mae_percent, time_to_tp1_ms, time_to_tp2_ms, time_to_stop_ms,",
    "return_percent, invalidated, invalidation_reason, sample_end_time",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "ON CONFLICT(signal_id, horizon_key) DO UPDATE SET",
    "evaluated_at = excluded.evaluated_at, status = excluded.status, tp1_hit = excluded.tp1_hit,",
    "tp2_hit = excluded.tp2_hit, stop_hit = excluded.stop_hit, mfe_percent = excluded.mfe_percent,",
    "mae_percent = excluded.mae_percent, time_to_tp1_ms = excluded.time_to_tp1_ms,",
    "time_to_tp2_ms = excluded.time_to_tp2_ms, time_to_stop_ms = excluded.time_to_stop_ms,",
    "return_percent = excluded.return_percent, invalidated = excluded.invalidated,",
    "invalidation_reason = excluded.invalidation_reason, sample_end_time = excluded.sample_end_time",
  ].join(String.fromCharCode(10))).run(
    signalId,
    outcome.horizonKey,
    outcome.horizonMs,
    outcome.evaluatedAt || null,
    outcome.status,
    outcome.tp1Hit === undefined ? null : outcome.tp1Hit ? 1 : 0,
    outcome.tp2Hit === undefined ? null : outcome.tp2Hit ? 1 : 0,
    outcome.stopHit === undefined ? null : outcome.stopHit ? 1 : 0,
    outcome.mfePercent ?? null,
    outcome.maePercent ?? null,
    outcome.timeToTp1Ms ?? null,
    outcome.timeToTp2Ms ?? null,
    outcome.timeToStopMs ?? null,
    outcome.returnPercent ?? null,
    outcome.invalidated ?? 0,
    outcome.invalidationReason || null,
    outcome.sampleEndTime ?? null
  );
  return result;
}

async function evaluateSignalOutcomes(options = {}) {
  const store = requireDb();
  const cutoff = Date.now() - Number(options.lookbackDays || 365) * 24 * 60 * 60 * 1000;
  const limit = Math.max(1, Math.min(Number(options.limit || MAX_SIGNALS_PER_RUN), MAX_SIGNALS_PER_RUN));
  const signals = store.prepare([
    "SELECT * FROM signal_quality_signals",
    "WHERE signal_time >= ? AND status != 'INACTIVE'",
    "ORDER BY signal_time ASC LIMIT ?",
  ].join(String.fromCharCode(10))).all(cutoff, limit);
  const now = Number(options.now || Date.now());
  const fetcher = options.fetchCandles || fetchHistoricalCandles;
  let evaluated = 0;
  let pending = 0;
  let noData = 0;
  const errors = [];

  for (const signal of signals) {
    try {
      const candles = await fetcher(signal, options);
      let signalEvaluated = false;
      for (const horizon of HORIZONS) {
        const outcome = computeOutcome(signal, candles, horizon, now);
        if (outcome.status === "PENDING") {
          pending += 1;
          continue;
        }
        if (outcome.status === "NO_DATA") {
          noData += 1;
          continue;
        }
        saveOutcome(signal.id, outcome);
        evaluated += 1;
        signalEvaluated = true;
      }
      if (signalEvaluated) {
        store.prepare([
          "UPDATE signal_quality_signals",
          "SET status = CASE WHEN status = 'OPEN' THEN 'EVALUATING' ELSE status END,",
          "invalidated_at = CASE WHEN invalidated_at IS NULL AND EXISTS (",
          "SELECT 1 FROM signal_quality_outcomes WHERE signal_id = ? AND invalidated = 1",
          ") THEN ? ELSE invalidated_at END,",
          "invalidation_reason = CASE WHEN invalidation_reason IS NULL AND EXISTS (",
          "SELECT 1 FROM signal_quality_outcomes WHERE signal_id = ? AND invalidated = 1",
          ") THEN 'STOP_HIT' ELSE invalidation_reason END",
          "WHERE id = ?",
        ].join(String.fromCharCode(10))).run(signal.id, now, signal.id, signal.id);
      }
    } catch (error) {
      errors.push(String(signal.symbol) + ": " + error.message);
    }
  }

  return {
    considered: signals.length,
    evaluated,
    pending,
    noData,
    errors: errors.slice(0, 10),
  };
}

function getMinimumObservations() {
  const configured = Number(process.env.PERPSIA_MIN_QUALITY_OBSERVATIONS || DEFAULT_MIN_OBSERVATIONS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MIN_OBSERVATIONS;
}

function confidenceBucket(value) {
  const confidence = finiteNumber(value);
  if (confidence === null) return "unknown";
  const normalized = confidence > 1 ? confidence / 100 : confidence;
  if (normalized < 0.5) return "<0.50";
  if (normalized < 0.7) return "0.50-0.69";
  if (normalized < 0.85) return "0.70-0.84";
  return "0.85+";
}

function average(values) {
  const finite = values.map(finiteNumber).filter((value) => value !== null);
  return finite.length ? round(finite.reduce((sum, value) => sum + value, 0) / finite.length, 4) : null;
}

function summarizeOutcomes(rows) {
  const evaluated = rows.filter((row) => row.status !== "PENDING" && row.status !== "NO_DATA");
  if (!evaluated.length) return { observations: 0 };
  const winners = evaluated.filter((row) => finiteNumber(row.return_percent) > 0);
  const losers = evaluated.filter((row) => finiteNumber(row.return_percent) < 0);
  const tp1 = evaluated.filter((row) => row.tp1_hit === 1);
  const tp2 = evaluated.filter((row) => row.tp2_hit === 1);
  const stops = evaluated.filter((row) => row.stop_hit === 1);
  return {
    observations: evaluated.length,
    winners: winners.length,
    losers: losers.length,
    winRate: round(winners.length / evaluated.length * 100, 2),
    tp1HitRate: round(tp1.length / evaluated.length * 100, 2),
    tp2HitRate: round(tp2.length / evaluated.length * 100, 2),
    stopRate: round(stops.length / evaluated.length * 100, 2),
    averageFavorableMove: average(evaluated.map((row) => row.mfe_percent)),
    averageAdverseMove: average(evaluated.map((row) => row.mae_percent)),
    averageReturn: average(evaluated.map((row) => row.return_percent)),
    averageTimeToTp1Ms: average(evaluated.map((row) => row.time_to_tp1_ms)),
    averageTimeToStopMs: average(evaluated.map((row) => row.time_to_stop_ms)),
  };
}

function groupRows(rows, keyFn) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return [...buckets.entries()].map(([key, values]) => ({
    key,
    ...summarizeOutcomes(values),
  })).sort((a, b) => (b.observations || 0) - (a.observations || 0));
}

function reportBreakdowns(rows, minimum) {
  if (rows.length < minimum) return { available: false, minimumObservations: minimum, groups: [] };
  const bySignal = groupRows(rows, (row) => row.signal_type || "UNKNOWN");
  const byConfidence = groupRows(rows, (row) => confidenceBucket(row.confidence_score));
  const byAsset = groupRows(rows, (row) => row.symbol || "UNKNOWN");
  const byRegime = groupRows(rows, (row) => row.market_regime || "UNKNOWN");
  const byDirection = groupRows(rows, (row) => row.direction || "UNKNOWN");
  const providerRows = [];
  const evidenceRows = [];
  for (const row of rows) {
    const providers = parseJson(row.providers_json, []);
    const groups = parseJson(row.evidence_groups_json, {}).groups || [];
    for (const provider of providers) providerRows.push({ ...row, provider: String(provider) });
    for (const group of groups) evidenceRows.push({ ...row, evidenceGroup: String(group) });
  }
  return {
    available: true,
    minimumObservations: minimum,
    performanceBySignalType: bySignal,
    performanceByConfidenceRange: byConfidence,
    performanceByAsset: byAsset,
    performanceByMarketRegime: byRegime,
    performanceByDirection: byDirection,
    performanceByProvider: groupRows(providerRows, (row) => row.provider),
    performanceByEvidenceGroup: groupRows(evidenceRows, (row) => row.evidenceGroup),
  };
}

function getSignalQualityReport(options = {}) {
  const store = requireDb();
  const requestedDays = Number(options.lookbackDays || 365);
  const days = Number.isFinite(requestedDays) ? Math.min(Math.max(Math.floor(requestedDays), 1), 3650) : 365;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const minimum = getMinimumObservations();
  const signals = store.prepare([
    "SELECT * FROM signal_quality_signals",
    "WHERE signal_time >= ? ORDER BY signal_time ASC",
  ].join(String.fromCharCode(10))).all(cutoff);
  const rowsByHorizon = {};
  for (const horizon of HORIZONS) {
    rowsByHorizon[horizon.key] = store.prepare([
      "SELECT q.*, s.symbol, s.signal_time, s.direction, s.score, s.confidence_score,",
      "s.signal_type, s.market_regime, s.providers_json, s.evidence_groups_json",
      "FROM signal_quality_outcomes q JOIN signal_quality_signals s ON s.id = q.signal_id",
      "WHERE q.horizon_key = ? AND s.signal_time >= ? AND q.status = 'EVALUATED'",
      "ORDER BY s.signal_time ASC",
    ].join(String.fromCharCode(10))).all(horizon.key, cutoff);
  }
  const horizons = {};
  for (const horizon of HORIZONS) {
    const rows = rowsByHorizon[horizon.key];
    horizons[horizon.key] = {
      observations: rows.length,
      sufficientObservations: rows.length >= minimum,
      statistics: rows.length >= minimum ? summarizeOutcomes(rows) : null,
      breakdowns: reportBreakdowns(rows, minimum),
    };
  }
  const selectedKey = String(options.horizon || "24h");
  const selectedRows = rowsByHorizon[selectedKey] || rowsByHorizon["24h"];
  const combinationRows = [];
  for (const row of selectedRows) {
    const groups = parseJson(row.evidence_groups_json, {}).groups || [];
    combinationRows.push({ ...row, evidenceCombination: groups.slice().sort().join("+") || "NONE" });
  }
  const combinations = selectedRows.length >= minimum
    ? groupRows(combinationRows, (row) => row.evidenceCombination)
    : [];
  const strongest = combinations.filter((item) => item.observations >= minimum).sort((a, b) => (b.winRate || 0) - (a.winRate || 0)).slice(0, 5);
  const weakest = combinations.filter((item) => item.observations >= minimum).sort((a, b) => (a.winRate || 0) - (b.winRate || 0)).slice(0, 5);
  return {
    status: signals.length >= minimum ? "ready" : "insufficient_observations",
    minimumObservations: minimum,
    lookbackDays: days,
    totalSignals: signals.length,
    actionableSignals: signals.length,
    evaluatedByHorizon: Object.fromEntries(HORIZONS.map((horizon) => [horizon.key, rowsByHorizon[horizon.key].length])),
    horizons,
    selectedHorizon: selectedKey,
    strongestEvidenceCombinations: strongest,
    weakestEvidenceCombinations: weakest,
    generatedAt: new Date().toISOString(),
    dataStatus: signals.length >= minimum ? "real_observations" : "collecting_real_observations",
    methodology: "Outcomes use public 1h futures candles. The same candle is resolved conservatively as stop before targets when both are touched. No result is estimated when candles are unavailable.",
  };
}

function getSignalQualityHealth() {
  const store = requireDb();
  const minimum = getMinimumObservations();
  const totalSignals = store.prepare("SELECT COUNT(*) AS count FROM signal_quality_signals").get().count;
  const evaluated24h = store.prepare("SELECT COUNT(*) AS count FROM signal_quality_outcomes WHERE horizon_key = '24h' AND status = 'EVALUATED'").get().count;
  const lastEvaluation = store.prepare("SELECT MAX(evaluated_at) AS value FROM signal_quality_outcomes WHERE status = 'EVALUATED'").get().value;
  return {
    status: totalSignals >= minimum ? "ready" : totalSignals ? "collecting" : "no_observations",
    totalSignals,
    evaluated24h,
    minimumObservations: minimum,
    lastEvaluationAt: lastEvaluation ? new Date(lastEvaluation).toISOString() : null,
  };
}

module.exports = {
  HORIZONS,
  computeOutcome,
  evaluateSignalOutcomes,
  fetchHistoricalCandles,
  getSignalQualityHealth,
  getSignalQualityReport,
  initializeSignalQuality,
  parseKlines,
  recordQualitySignal,
  saveOutcome,
};
