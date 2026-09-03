// ==========================================
// PERPSIA PAPER PERFORMANCE LEADERBOARD
// ==========================================
// Live entries are paper signals only. Closed outcomes are settled against
// public Binance futures candles and never presented as audited performance.

const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "perpsia.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec([
  "CREATE TABLE IF NOT EXISTS performance_signals (",
  "id TEXT PRIMARY KEY,",
  "symbol TEXT NOT NULL,",
  "venue TEXT NOT NULL,",
  "direction TEXT NOT NULL,",
  "entry_price REAL NOT NULL,",
  "stop_price REAL NOT NULL,",
  "tp1_price REAL NOT NULL,",
  "tp2_price REAL,",
  "signal_time INTEGER NOT NULL,",
  "source TEXT NOT NULL,",
  "status TEXT NOT NULL DEFAULT 'OPEN',",
  "exit_time INTEGER,",
  "exit_price REAL,",
  "exit_reason TEXT,",
  "pnl_percent REAL,",
  "created_at TEXT DEFAULT CURRENT_TIMESTAMP,",
  "settled_at TEXT",
  ")",
  "CREATE INDEX IF NOT EXISTS idx_performance_signal_time ON performance_signals(signal_time)",
  "CREATE INDEX IF NOT EXISTS idx_performance_signal_status ON performance_signals(status)",
].join(String.fromCharCode(10)));

const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 365;
const CANDLE_INTERVAL = "1h";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(symbol) {
  const value = String(symbol || "")
    .trim()
    .replace(String.fromCharCode(36), "")
    .toUpperCase();

  return value.endsWith("USDT") ? value : value + "USDT";
}

function normalizeDirection(direction) {
  const value = String(direction || "").toLowerCase();
  if (value.includes("short") || value === "bearish") return "SHORT";
  if (value.includes("long") || value === "bullish") return "LONG";
  return null;
}

function extractNumbers(value) {
  const matches = String(value || "").match(new RegExp("[-+]?[0-9]+(?:[.][0-9]+)?", "g")) || [];
  return matches.map(Number).filter(Number.isFinite);
}

function resolveEntryPrice(entry, currentPrice) {
  const direct = number(entry);
  if (direct !== null && direct > 0) return direct;

  const values = extractNumbers(entry).filter((item) => item > 0);
  const current = number(currentPrice);
  if (!values.length) return current;
  if (values.length === 1) return values[0];

  const low = Math.min(...values);
  const high = Math.max(...values);
  return current !== null && current >= low && current <= high
    ? current
    : (low + high) / 2;
}

function round(value, digits = 6) {
  const parsed = number(value);
  return parsed === null ? null : Number(parsed.toFixed(digits));
}

function makeSignalId(signal, observedAt) {
  const bucket = Math.floor(observedAt / (4 * 60 * 60 * 1000));
  const identity = [
    String(signal.symbol || "").toUpperCase(),
    normalizeDirection(signal.direction),
    round(resolveEntryPrice(signal.entry, signal.price), 6),
    round(signal.stop, 6),
    round(signal.tp1, 6),
    bucket,
  ].join("|");

  return crypto.createHash("sha1").update(identity).digest("hex");
}

function validLevels(direction, entry, stop, tp1) {
  return direction === "LONG"
    ? stop < entry && tp1 > entry
    : stop > entry && tp1 < entry;
}

function recordSignal(signal, source = "live") {
  if (!signal?.isActionable) {
    return { recorded: false, reason: "not_actionable" };
  }

  const direction = normalizeDirection(signal.direction);
  const entry = resolveEntryPrice(signal.entry, signal.price);
  const stop = number(signal.stop);
  const tp1 = number(signal.tp1);
  const tp2 = number(signal.tp2);

  if (
    !direction ||
    entry === null ||
    stop === null ||
    tp1 === null ||
    !validLevels(direction, entry, stop, tp1)
  ) {
    return { recorded: false, reason: "invalid_trade_levels" };
  }

  const observedAt = Date.now();
  const id = makeSignalId(signal, observedAt);
  const result = db.prepare([
    "INSERT OR IGNORE INTO performance_signals (",
    "id, symbol, venue, direction, entry_price, stop_price, tp1_price,",
    "tp2_price, signal_time, source",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ].join(String.fromCharCode(10))).run(
    id,
    String(signal.symbol || "").toUpperCase(),
    String(signal.venue || "Binance"),
    direction,
    entry,
    stop,
    tp1,
    tp2,
    observedAt,
    source
  );

  return {
    recorded: result.changes > 0,
    id,
    status: "OPEN",
  };
}

function getOpenSignals(cutoffTime) {
  return db.prepare([
    "SELECT * FROM performance_signals",
    "WHERE status = 'OPEN' AND signal_time >= ?",
    "ORDER BY signal_time ASC",
  ].join(String.fromCharCode(10))).all(cutoffTime);
}

function pnlPercent(direction, entry, exit) {
  return direction === "SHORT"
    ? ((entry - exit) / entry) * 100
    : ((exit - entry) / entry) * 100;
}

function parseKlines(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      timestamp: number(row?.[0]),
      high: number(row?.[2]),
      low: number(row?.[3]),
      close: number(row?.[4]),
    }))
    .filter((row) => [row.timestamp, row.high, row.low, row.close].every((value) => value !== null))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function findExit(candles, signal) {
  for (const candle of candles) {
    const stopHit = signal.direction === "LONG"
      ? candle.low <= signal.stop_price
      : candle.high >= signal.stop_price;
    const tp2Hit = signal.tp2_price !== null && (
      signal.direction === "LONG"
        ? candle.high >= signal.tp2_price
        : candle.low <= signal.tp2_price
    );
    const tp1Hit = signal.direction === "LONG"
      ? candle.high >= signal.tp1_price
      : candle.low <= signal.tp1_price;

    if (stopHit) {
      return { time: candle.timestamp, price: signal.stop_price, reason: "STOP_HIT", status: "LOST" };
    }

    if (tp2Hit) {
      return { time: candle.timestamp, price: signal.tp2_price, reason: "TP2_HIT", status: "WON" };
    }

    if (tp1Hit) {
      return { time: candle.timestamp, price: signal.tp1_price, reason: "TP1_HIT", status: "WON" };
    }
  }

  return null;
}

async function fetchCandles(signal, options = {}) {
  const httpClient = options.httpClient || axios;
  const baseUrl = options.futuresBaseUrl ||
    process.env.PERFORMANCE_FUTURES_BASE_URL ||
    "https://fapi.binance.com";

  const response = await httpClient.get(baseUrl + "/fapi/v1/klines", {
    params: {
      symbol: normalizeSymbol(signal.symbol),
      interval: CANDLE_INTERVAL,
      startTime: signal.signal_time,
      endTime: Date.now(),
      limit: 1500,
    },
    timeout: 12000,
  });

  return parseKlines(response.data);
}

async function settleOpenSignals(options = {}) {
  const requestedDays = Number(options.lookbackDays || DEFAULT_LOOKBACK_DAYS);
  const lookbackDays = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.floor(requestedDays), 1), MAX_LOOKBACK_DAYS)
    : DEFAULT_LOOKBACK_DAYS;
  const cutoffTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const openSignals = getOpenSignals(cutoffTime);
  let settled = 0;
  const errors = [];

  for (const signal of openSignals.slice(0, 100)) {
    try {
      const candles = await fetchCandles(signal, options);
      const candlesAfterEntry = candles.filter((candle) => candle.timestamp > signal.signal_time);
      const exit = findExit(candlesAfterEntry, signal);

      if (!exit) continue;

      db.prepare([
        "UPDATE performance_signals",
        "SET status = ?, exit_time = ?, exit_price = ?, exit_reason = ?,",
        "pnl_percent = ?, settled_at = CURRENT_TIMESTAMP",
        "WHERE id = ? AND status = 'OPEN'",
      ].join(String.fromCharCode(10))).run(
        exit.status,
        exit.time,
        exit.price,
        exit.reason,
        round(pnlPercent(signal.direction, signal.entry_price, exit.price), 6),
        signal.id
      );
      settled += 1;
    } catch (error) {
      errors.push(signal.symbol + ": " + error.message);
    }
  }

  return {
    considered: openSignals.length,
    settled,
    errors: errors.slice(0, 10),
  };
}

function formatPercent(value, digits = 2) {
  const parsed = number(value) || 0;
  return parsed.toFixed(digits) + "%";
}

function calculateStats(trades) {
  const winners = trades.filter((trade) => trade.pnl_percent > 0);
  const losers = trades.filter((trade) => trade.pnl_percent < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.pnl_percent, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.pnl_percent, 0));
  const returns = trades.map((trade) => trade.pnl_percent);
  const mean = returns.length
    ? returns.reduce((sum, value) => sum + value, 0) / returns.length
    : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1)
    : 0;
  const standardDeviation = Math.sqrt(variance);

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let consecutiveWins = 0;
  let maxConsecutiveWins = 0;

  for (const trade of trades) {
    equity *= 1 + trade.pnl_percent / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak ? ((peak - equity) / peak) * 100 : 0);

    if (trade.pnl_percent > 0) {
      consecutiveWins += 1;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, consecutiveWins);
    } else {
      consecutiveWins = 0;
    }
  }

  return {
    winners: winners.length,
    losers: losers.length,
    breakeven: trades.filter((trade) => trade.pnl_percent === 0).length,
    win_rate: trades.length ? formatPercent((winners.length / trades.length) * 100, 0) : "0%",
    avg_win: winners.length ? formatPercent(grossProfit / winners.length) : "0.00%",
    avg_loss: losers.length ? formatPercent(-(grossLoss / losers.length)) : "0.00%",
    profit_factor: grossLoss ? round(grossProfit / grossLoss, 4) : grossProfit ? null : 0,
    max_consecutive_wins: maxConsecutiveWins,
    sharpe_ratio: standardDeviation ? round((mean / standardDeviation) * Math.sqrt(returns.length), 4) : 0,
    max_drawdown: formatPercent(maxDrawdown),
    total_return: formatPercent((equity - 1) * 100),
    gross_profit: round(grossProfit, 4),
    gross_loss: round(grossLoss, 4),
  };
}

async function getPerformance(options = {}) {
  const requestedDays = Number(options.lookbackDays || DEFAULT_LOOKBACK_DAYS);
  const lookbackDays = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.floor(requestedDays), 1), MAX_LOOKBACK_DAYS)
    : DEFAULT_LOOKBACK_DAYS;
  const cutoffTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const settlement = options.settle === false
    ? { considered: 0, settled: 0, errors: [] }
    : await settleOpenSignals({ ...options, lookbackDays });

  const signals = db.prepare([
    "SELECT * FROM performance_signals",
    "WHERE signal_time >= ?",
    "ORDER BY signal_time ASC",
  ].join(String.fromCharCode(10))).all(cutoffTime);
  const closed = signals.filter((signal) => ["WON", "LOST"].includes(signal.status));
  const openSignals = signals.filter((signal) => signal.status === "OPEN");
  const stats = calculateStats(closed);

  return {
    last_30_days: {
      total_signals: signals.length,
      closed_signals: closed.length,
      open_signals: openSignals.length,
      winners: stats.winners,
      losers: stats.losers,
      breakeven: stats.breakeven,
      win_rate: stats.win_rate,
      avg_win: stats.avg_win,
      avg_loss: stats.avg_loss,
      profit_factor: stats.profit_factor,
      max_consecutive_wins: stats.max_consecutive_wins,
      sharpe_ratio: stats.sharpe_ratio,
      max_drawdown: stats.max_drawdown,
      total_return: stats.total_return,
    },
    live_dashboard: process.env.PERFORMANCE_DASHBOARD_URL || "/performance",
    verified_by: process.env.PERFORMANCE_VERIFIED_BY || null,
    data_status: closed.length ? "paper_signal_history" : "no_settled_signals",
    generated_at: new Date().toISOString(),
    methodology: "Paper signals are recorded from actionable Perpsia analyses and settled conservatively against public Binance futures 1h candles. Open signals are excluded from win rate.",
    settlement,
  };
}

function getPerformanceRows(options = {}) {
  const requestedDays = Number(options.lookbackDays || DEFAULT_LOOKBACK_DAYS);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.floor(requestedDays), 1), MAX_LOOKBACK_DAYS)
    : DEFAULT_LOOKBACK_DAYS;
  const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;

  return db.prepare([
    "SELECT symbol, venue, direction, entry_price, stop_price, tp1_price,",
    "tp2_price, signal_time, status, exit_time, exit_price,",
    "exit_reason, pnl_percent, source",
    "FROM performance_signals",
    "WHERE signal_time >= ?",
    "ORDER BY signal_time DESC LIMIT 200",
  ].join(String.fromCharCode(10))).all(cutoffTime);
}

module.exports = {
  getPerformance,
  getPerformanceRows,
  recordSignal,
  settleOpenSignals,
};
