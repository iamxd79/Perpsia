"use strict";

const { normalizeVenue } = require("./exchangeAdapter");

const VENUE_DEFINITIONS = {
  Binance: {
    provider: "binance",
    hosts: ["binance.com"],
  },
  Hyperliquid: {
    provider: "hyperliquid",
    hosts: ["hyperliquid.xyz"],
  },
  Bybit: {
    provider: "bybit",
    hosts: ["bybit.com"],
  },
  OKX: {
    provider: "okx",
    hosts: ["okx.com"],
  },
};

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceRecords(signal = {}) {
  if (Array.isArray(signal.marketEvidence)) return signal.marketEvidence;
  if (Array.isArray(signal.marketEvidence?.records)) return signal.marketEvidence.records;
  if (Array.isArray(signal.evidenceRecords)) return signal.evidenceRecords;
  return [];
}

function marketFromEvidence(record, venue, symbol) {
  const metadata = record?.metadata || {};
  if (!record || record.status !== "ok") return null;
  if (!String(record.marketType || "").toLowerCase().includes("perp")) return null;
  if (finiteNumber(record.perpPrice ?? record.price) === null) return null;

  let market = null;
  if (venue === "Binance" || venue === "Bybit") market = metadata.pair;
  if (venue === "OKX") market = metadata.swap;
  if (venue === "Hyperliquid") market = metadata.coin;
  market = String(market || "").trim();
  if (!market) return null;

  const asset = normalizeSymbol(symbol);
  const compactMarket = market.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!asset || !compactMarket.startsWith(asset)) return null;

  return {
    available: true,
    venue,
    symbol: asset,
    market,
    provider: String(record.provider || "").toLowerCase(),
    price: finiteNumber(record.perpPrice ?? record.price),
    evidence: record,
  };
}

function getAvailableMarkets(signal = {}) {
  const symbol = normalizeSymbol(signal.symbol);
  const records = evidenceRecords(signal);
  const markets = [];

  for (const venue of Object.keys(VENUE_DEFINITIONS)) {
    const provider = VENUE_DEFINITIONS[venue].provider;
    const record = records.find(
      (item) => String(item?.provider || "").toLowerCase() === provider
    );
    const market = marketFromEvidence(record, venue, symbol);
    if (market) markets.push(market);
  }

  return markets;
}

function isAllowedReferralUrl(value, allowedHosts) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return allowedHosts.some(
      (host) => hostname === host || hostname.endsWith("." + host)
    );
  } catch {
    return false;
  }
}

function directTradingUrl(venue, market) {
  const encoded = encodeURIComponent(market);
  if (venue === "Binance" && /^[A-Z0-9]+USDT$/.test(market)) {
    return "https://www.binance.com/en/futures/" + encoded;
  }
  if (venue === "Bybit" && /^[A-Z0-9]+USDT$/.test(market)) {
    return "https://www.bybit.com/trade/usdt/" + encoded;
  }
  if (venue === "OKX" && /^[A-Z0-9]+-USDT-SWAP$/.test(market)) {
    return "https://www.okx.com/trade-swap/" + market.toLowerCase();
  }
  if (venue === "Hyperliquid" && /^[A-Z0-9]+$/.test(market)) {
    return "https://app.hyperliquid.xyz/trade/" + encoded;
  }
  return null;
}

function referralFallback(venue, config = {}) {
  const definition = VENUE_DEFINITIONS[venue];
  if (!definition) return null;
  const code = String(config.code || "").trim();
  const configuredUrl = String(config.url || "").trim();

  if (
    configuredUrl &&
    isAllowedReferralUrl(configuredUrl, definition.hosts) &&
    (!code || configuredUrl.toLowerCase().includes(code.toLowerCase()))
  ) {
    return configuredUrl;
  }

  if (venue === "Binance" && code) {
    return "https://www.binance.com/register?ref=" + encodeURIComponent(code);
  }

  return null;
}

function buildTradingLink({ venue, symbol, market, referralConfig = {} } = {}) {
  let canonicalVenue;
  try {
    canonicalVenue = normalizeVenue(venue);
  } catch {
    return null;
  }
  if (!VENUE_DEFINITIONS[canonicalVenue]) return null;
  if (!market?.available || market.venue !== canonicalVenue) return null;
  if (normalizeSymbol(symbol) !== normalizeSymbol(market.symbol)) return null;

  const marketName = String(market.market || "").toUpperCase();
  const directUrl = directTradingUrl(canonicalVenue, marketName);
  if (!directUrl) return null;

  const referralUrl = referralFallback(canonicalVenue, referralConfig);
  return {
    venue: canonicalVenue,
    symbol: normalizeSymbol(symbol),
    market: marketName,
    url: referralUrl || directUrl,
    directUrl,
    referralApplied: Boolean(referralUrl),
    linkType: referralUrl ? "referral_fallback" : "direct_market",
  };
}

function getReferralConfig(env = process.env) {
  return {
    Binance: {
      code: String(env.BINANCE_REF_CODE || "").trim(),
      url: String(env.BINANCE_REF_URL || "").trim(),
    },
    Hyperliquid: {
      code: String(env.HYPERLIQUID_REF_CODE || "").trim(),
      url: String(env.HYPERLIQUID_REF_URL || "").trim(),
    },
    Bybit: {
      code: String(env.BYBIT_REF_CODE || "").trim(),
      url: String(env.BYBIT_REF_URL || "").trim(),
    },
    OKX: {
      code: String(env.OKX_REF_CODE || "").trim(),
      url: String(env.OKX_REF_URL || "").trim(),
    },
  };
}

function buildTradingLinksForSignal(signal, env = process.env) {
  if (!signal?.isActionable) return [];
  const config = getReferralConfig(env);
  return getAvailableMarkets(signal)
    .map((market) =>
      buildTradingLink({
        venue: market.venue,
        symbol: signal.symbol,
        market,
        referralConfig: config[market.venue],
      })
    )
    .filter(Boolean);
}

module.exports = {
  VENUE_DEFINITIONS,
  buildTradingLink,
  buildTradingLinksForSignal,
  directTradingUrl,
  getAvailableMarkets,
  getReferralConfig,
  isAllowedReferralUrl,
  marketFromEvidence,
  normalizeSymbol,
};
