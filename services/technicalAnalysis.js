"use strict";

const axios = require("axios");
const {
  CircuitBreaker,
  executeWithResilience,
} = require("./resilience");
const { analyzeSMC, atr, normalizeCandles } = require("./smcAnalysis");

const BINANCE_FUTURES = "https://fapi.binance.com";
const cache = new Map();
const breaker = new CircuitBreaker(4, 60000, { name: "Binance OHLCV" });

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(symbol) {
  const value = String(symbol || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase();
  return value.endsWith("USDT") ? value : value + "USDT";
}

function ema(values, period) {
  if (!values.length) return null;
  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / Math.min(period, values.length);
  for (let index = period; index < values.length; index += 1) {
    result = (values[index] - result) * multiplier + result;
  }
  return result;
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(0, change)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(0, -change)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - (100 / (1 + averageGain / averageLoss));
}

function volumeRatio(candles, period = 20) {
  const current = number(candles.at(-1)?.volume);
  const previous = candles.slice(-period - 1, -1).map((candle) => number(candle.volume)).filter((value) => value !== null && value > 0);
  if (current === null || !previous.length) return null;
  const average = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  return average > 0 ? current / average : null;
}

function analyzeTechnical(candles, options = {}) {
  const normalized = normalizeCandles(candles);
  if (normalized.length < 20) {
    return { status: "unavailable", reason: "insufficient_ohlcv", candleCount: normalized.length };
  }
  const closes = normalized.map((candle) => candle.close);
  const price = closes.at(-1);
  const prior = closes.at(-25) ?? closes[0];
  const priceChange = prior ? ((price - prior) / prior) * 100 : null;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const currentAtr = atr(normalized);
  const smc = analyzeSMC(normalized, options);
  const trend = ema20 !== null && ema50 !== null
    ? price > ema20 && ema20 > ema50 ? "BULLISH" : price < ema20 && ema20 < ema50 ? "BEARISH" : "MIXED"
    : "UNKNOWN";
  const rsiValue = rsi(closes);
  const technicalDirection = trend === "BULLISH" ? "BULLISH" : trend === "BEARISH" ? "BEARISH" : "NEUTRAL";

  return {
    status: "available",
    candleCount: normalized.length,
    interval: options.interval || "1h",
    price,
    priceChange,
    atr: currentAtr,
    atrPercent: currentAtr && price ? (currentAtr / price) * 100 : null,
    ema20,
    ema50,
    rsi: rsiValue,
    volumeRatio: volumeRatio(normalized),
    trend,
    direction: technicalDirection,
    smc,
  };
}

async function fetchBinanceCandles(symbol, options = {}) {
  const client = options.httpClient || axios;
  const interval = options.interval || "1h";
  const limit = Math.min(500, Math.max(40, Number(options.limit || 240)));
  const marketSymbol = normalizeSymbol(symbol);
  const cacheKey = marketSymbol + ":" + interval + ":" + limit;
  const cacheTtlMs = Number(options.cacheTtlMs || 60000);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < cacheTtlMs) return cached.candles;

  const response = await executeWithResilience(
    () => client.get(BINANCE_FUTURES + "/fapi/v1/klines", {
      params: { symbol: marketSymbol, interval, limit },
      timeout: Number(options.timeoutMs || 8000),
    }),
    { breaker, retries: Number(options.retries ?? 1), baseDelayMs: 250, maxDelayMs: 1500 },
  );
  const candles = normalizeCandles(response.data);
  if (candles.length < 20) throw new Error("Binance returned insufficient OHLCV data");
  cache.set(cacheKey, { candles, timestamp: Date.now() });
  return candles;
}

async function analyzeTechnicalContext(symbol, options = {}) {
  if (options.enabled === false || process.env.PERPSIA_ENABLE_TECHNICAL_CONTEXT === "false") {
    return { status: "disabled", evidence: null };
  }
  try {
    const candles = options.candles || await fetchBinanceCandles(symbol, options);
    const analysis = analyzeTechnical(candles, options);
    if (analysis.status !== "available") return { ...analysis, evidence: null };
    return {
      ...analysis,
      evidence: {
        provider: "binance_technical",
        symbol: String(symbol || "").replace(/^\$/, "").toUpperCase(),
        timestamp: candles.at(-1).timestamp,
        marketType: "technical",
        price: analysis.price,
        priceChange: analysis.priceChange,
        volume: candles.at(-1).volume,
        status: "ok",
        sourceConfidence: 0.78,
        metadata: {
          exchange: "Binance",
          transport: "REST OHLCV",
          interval: analysis.interval,
          candleCount: analysis.candleCount,
          trend: analysis.trend,
          ema20: analysis.ema20,
          ema50: analysis.ema50,
          rsi: analysis.rsi,
          atrPercent: analysis.atrPercent,
          volumeRatio: analysis.volumeRatio,
          smcDirection: analysis.smc.direction,
          smcBiasScore: analysis.smc.biasScore,
        },
      },
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error.message,
      evidence: {
        provider: "binance_technical",
        symbol: String(symbol || "").replace(/^\$/, "").toUpperCase(),
        marketType: "technical",
        status: "unavailable",
        sourceConfidence: 0,
        error: error.message,
      },
    };
  }
}

module.exports = {
  analyzeTechnical,
  analyzeTechnicalContext,
  fetchBinanceCandles,
  normalizeSymbol,
};
