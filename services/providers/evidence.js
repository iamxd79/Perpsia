"use strict";

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(max, Math.max(min, number));
}

function normalizeOrderbook(orderbook) {
  if (!orderbook || typeof orderbook !== "object") return null;
  const bidVolume = finiteNumber(orderbook.bidVolume ?? orderbook.bids);
  const askVolume = finiteNumber(orderbook.askVolume ?? orderbook.asks);
  let imbalance = finiteNumber(orderbook.imbalance);
  if (imbalance === null && bidVolume !== null && askVolume !== null && bidVolume + askVolume > 0) {
    imbalance = (bidVolume - askVolume) / (bidVolume + askVolume);
  }
  return {
    bidVolume,
    askVolume,
    imbalance: clamp(imbalance, -1, 1),
    spreadBps: finiteNumber(orderbook.spreadBps),
    depth: finiteNumber(orderbook.depth),
  };
}

function normalizeFreshness(timestamp, freshness, now = Date.now()) {
  if (freshness && typeof freshness === "object") {
    return {
      ageMs: finiteNumber(freshness.ageMs),
      status: String(freshness.status || "unknown"),
      maxAgeMs: finiteNumber(freshness.maxAgeMs),
    };
  }
  const time = finiteNumber(timestamp);
  if (time === null) return { ageMs: null, status: "missing", maxAgeMs: null };
  const ageMs = Math.max(0, now - time);
  const maxAgeMs = 120000;
  return {
    ageMs,
    status: ageMs <= maxAgeMs ? "fresh" : "stale",
    maxAgeMs,
  };
}

function normalizeEvidence(input = {}) {
  const timestamp = finiteNumber(input.timestamp) ?? Date.now();
  const status = String(input.status || "ok");
  const normalized = {
    provider: String(input.provider || "unknown"),
    symbol: String(input.symbol || "").toUpperCase(),
    timestamp,
    marketType: input.marketType ? String(input.marketType) : null,
    chain: input.chain ? String(input.chain) : null,
    price: finiteNumber(input.price),
    volume: finiteNumber(input.volume),
    openInterest: finiteNumber(input.openInterest),
    funding: finiteNumber(input.funding),
    trades: finiteNumber(input.trades),
    orderbook: normalizeOrderbook(input.orderbook),
    liquidity: finiteNumber(input.liquidity),
    priceChange: finiteNumber(input.priceChange),
    priceChange24h: finiteNumber(input.priceChange24h),
    spotPrice: finiteNumber(input.spotPrice),
    perpPrice: finiteNumber(input.perpPrice),
    securityRisk: input.securityRisk === null || input.securityRisk === undefined
      ? null
      : clamp(input.securityRisk, 0, 100),
    sourceConfidence: clamp(input.sourceConfidence ?? (status === "ok" ? 0.8 : 0), 0, 1) ?? 0,
    freshness: normalizeFreshness(timestamp, input.freshness),
    status,
    error: input.error ? String(input.error) : null,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };
  if (status === "unavailable") {
    normalized.sourceConfidence = 0;
    normalized.freshness = { ageMs: null, status: "missing", maxAgeMs: null };
  }
  return normalized;
}

function unavailableEvidence(provider, symbol, error, metadata = {}) {
  return normalizeEvidence({
    provider,
    symbol,
    status: "unavailable",
    error: error?.message || String(error || "provider unavailable"),
    sourceConfidence: 0,
    metadata,
  });
}

function summarizeEvidence(records) {
  const list = Array.isArray(records) ? records : [];
  const available = list.filter((item) => item && item.status === "ok");
  return {
    total: list.length,
    available: available.length,
    unavailable: list.length - available.length,
    providers: list.map((item) => ({
      provider: item.provider,
      status: item.status,
      freshness: item.freshness?.status || "unknown",
      sourceConfidence: item.sourceConfidence,
    })),
  };
}

module.exports = {
  clamp,
  finiteNumber,
  normalizeEvidence,
  normalizeFreshness,
  normalizeOrderbook,
  summarizeEvidence,
  unavailableEvidence,
};
