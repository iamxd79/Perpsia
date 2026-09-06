"use strict";

// Evidence freshness is deliberately explicit and field-aware. A single global
// TTL would make order books look usable long after they stopped being useful.
const FRESHNESS_THRESHOLDS_MS = Object.freeze({
  orderbook: 5_000,
  price: 15_000,
  derivatives: 120_000,
  dex: 180_000,
  technical: 120_000,
  macro: 3_600_000,
  security: 86_400_000,
  project: 21_600_000,
  research: 1_800_000,
  default: 120_000,
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function providerClass(record = {}) {
  const provider = String(record.provider || "").toLowerCase();
  const marketType = String(record.marketType || "").toLowerCase();
  const metadataClass = String(record.metadata?.freshnessClass || "").toLowerCase();

  if (metadataClass && FRESHNESS_THRESHOLDS_MS[metadataClass]) return metadataClass;
  if (record.orderbook) return "orderbook";
  if (provider === "goplus" || provider === "honeypot" || record.securityRisk !== null && record.securityRisk !== undefined) return "security";
  if (provider === "alternative" || provider === "fred" || marketType.includes("macro")) return "macro";
  if (provider === "github" || marketType.includes("project")) return "project";
  if (provider === "grok" || marketType.includes("research")) return "research";
  if (marketType.includes("dex") || provider === "dexscreener" || provider === "geckoterminal") return "dex";
  if (marketType.includes("technical") || provider === "binance_technical" || provider === "smc") return "technical";
  if (marketType.includes("perp") || marketType.includes("future") || record.funding !== null && record.funding !== undefined || record.openInterest !== null && record.openInterest !== undefined) return "derivatives";
  if (record.price !== null && record.price !== undefined) return "price";
  return "default";
}

function evaluateFreshness(record = {}, now = Date.now(), supplied = null) {
  const sourceTimestamp = finite(record.timestamp);
  const suppliedAge = finite(supplied?.ageMs);
  const ageMs = sourceTimestamp !== null
    ? Math.max(0, now - sourceTimestamp)
    : suppliedAge;
  const freshnessClass = String(supplied?.freshnessClass || providerClass(record));
  const maxAgeMs = finite(supplied?.maxAgeMs) ?? FRESHNESS_THRESHOLDS_MS[freshnessClass] ?? FRESHNESS_THRESHOLDS_MS.default;
  const status = String(record.status || "ok");
  const usable = status === "ok" && ageMs !== null && ageMs <= maxAgeMs;
  let reason = null;
  if (status !== "ok") reason = status === "stale" ? "provider returned stale evidence" : "provider is unavailable";
  else if (ageMs === null) reason = "source timestamp is missing";
  else if (ageMs > maxAgeMs) reason = "evidence exceeded its freshness threshold";

  return {
    ageMs,
    status: usable ? "fresh" : status === "ok" ? "stale" : status,
    maxAgeMs,
    freshnessClass,
    usable,
    reason,
  };
}

function applyFreshness(record, now = Date.now()) {
  const freshness = evaluateFreshness(record, now, record.freshness);
  return {
    ...record,
    freshness,
    stale: freshness.status === "stale",
    usable: freshness.usable,
  };
}

module.exports = {
  FRESHNESS_THRESHOLDS_MS,
  applyFreshness,
  evaluateFreshness,
  providerClass,
};
