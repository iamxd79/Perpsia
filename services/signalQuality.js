"use strict";

const PROVIDER_GROUPS = {
  coinmarketcap: ["DERIVATIVES", "SPOT", "ORDERBOOK", "ONCHAIN"],
  cmc: ["DERIVATIVES", "SPOT", "ORDERBOOK", "ONCHAIN"],
  binance: ["DERIVATIVES", "SPOT", "ORDERBOOK"],
  bybit: ["DERIVATIVES", "SPOT", "ORDERBOOK"],
  okx: ["DERIVATIVES", "SPOT", "ORDERBOOK"],
  hyperliquid: ["DERIVATIVES", "ORDERBOOK"],
  dexscreener: ["DEX"],
  geckoterminal: ["DEX"],
  goplus: ["SECURITY"],
  honeypot: ["SECURITY"],
  fred: ["MACRO"],
  alternative: ["MACRO"],
  github: ["PROJECT_ACTIVITY"],
  whale_alert: ["ONCHAIN"],
  onchain: ["ONCHAIN"],
};

const CEX_PROVIDERS = ["binance", "bybit", "okx", "hyperliquid"];
const HORIZONS = [
  { key: "1h", ms: 60 * 60 * 1000 },
  { key: "4h", ms: 4 * 60 * 60 * 1000 },
  { key: "12h", ms: 12 * 60 * 60 * 1000 },
  { key: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "72h", ms: 72 * 60 * 60 * 1000 },
];

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDirection(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("short") || text.includes("bearish")) return "SHORT";
  if (text.includes("long") || text.includes("bullish")) return "LONG";
  return null;
}

function normalizeProvider(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

function groupForProvider(provider, record = {}) {
  const normalized = normalizeProvider(provider);
  const known = PROVIDER_GROUPS[normalized];
  if (known && known.length) {
    const marketType = String(record.marketType || "").toLowerCase();
    const groups = [];
    if (normalized === "coinmarketcap" || normalized === "cmc" || marketType.includes("perp") || marketType.includes("future") || record.openInterest !== null && record.openInterest !== undefined || record.funding !== null && record.funding !== undefined) groups.push("DERIVATIVES");
    if (marketType.includes("spot") || record.spotPrice !== null && record.spotPrice !== undefined) groups.push("SPOT");
    if (record.orderbook) groups.push("ORDERBOOK");
    if (groups.length) return [...new Set(groups)];
    return [known[0]];
  }
  const marketType = String(record.marketType || "").toLowerCase();
  if (marketType.includes("dex")) return ["DEX"];
  if (marketType.includes("spot")) return ["SPOT"];
  if (marketType.includes("perp") || marketType.includes("future")) return ["DERIVATIVES"];
  if (record.securityRisk !== null && record.securityRisk !== undefined) return ["SECURITY"];
  return ["ONCHAIN"];
}

function getEvidenceRecords(signal = {}) {
  const values = [];
  if (Array.isArray(signal.marketEvidence)) values.push(...signal.marketEvidence);
  if (Array.isArray(signal.evidenceRecords)) values.push(...signal.evidenceRecords);
  return values.filter((item) => item && typeof item === "object");
}

function evidenceDirection(record) {
  const priceChange = finiteNumber(record.priceChange24h ?? record.priceChange);
  const orderbookImbalance = finiteNumber(record.orderbook?.imbalance);
  if (orderbookImbalance !== null && Math.abs(orderbookImbalance) >= 0.08) {
    return orderbookImbalance > 0 ? "LONG" : "SHORT";
  }
  if (priceChange !== null && Math.abs(priceChange) >= 0.25) {
    return priceChange > 0 ? "LONG" : "SHORT";
  }
  const funding = finiteNumber(record.funding);
  if (funding !== null && Math.abs(funding) >= 0.01) {
    return funding < 0 ? "LONG" : "SHORT";
  }
  return null;
}

function groupEvidence(signal = {}) {
  const grouped = {};
  const records = getEvidenceRecords(signal);
  for (const record of records) {
    if (record.status && record.status !== "ok") continue;
    const provider = normalizeProvider(record.provider);
    for (const group of groupForProvider(provider, record)) {
      if (!grouped[group]) {
        grouped[group] = {
          group,
          providers: [],
          records: [],
          fields: [],
          directions: [],
          direction: null,
        };
      }
      const item = grouped[group];
      if (!item.providers.includes(provider)) item.providers.push(provider);
      item.records.push(record);
      for (const field of ["price", "volume", "openInterest", "funding", "trades", "orderbook", "liquidity", "priceChange", "spotPrice", "perpPrice", "securityRisk"]) {
        if (record[field] !== null && record[field] !== undefined && !item.fields.includes(field)) item.fields.push(field);
      }
      const direction = evidenceDirection(record);
      if (direction && !item.directions.includes(direction)) item.directions.push(direction);
    }
  }

  if (signal.hasCoreData && signal.evidence) {
    if (!grouped.DERIVATIVES) {
      grouped.DERIVATIVES = {
        group: "DERIVATIVES",
        providers: [],
        records: [],
        fields: ["price", "openInterest", "funding", "priceChange"],
        directions: [],
        direction: normalizeDirection(signal.direction),
      };
    }
    if (!grouped.DERIVATIVES.providers.includes("coinmarketcap")) grouped.DERIVATIVES.providers.push("coinmarketcap");
  }

  const requestedDirection = normalizeDirection(signal.direction);
  for (const item of Object.values(grouped)) {
    if (item.directions.length === 1) item.direction = item.directions[0];
    else if (item.directions.length > 1) item.direction = "MIXED";
    else if (item.group === "SECURITY") item.direction = "NON_DIRECTIONAL";
    else item.direction = null;
  }

  const groups = Object.keys(grouped).sort();
  const conflicts = Array.isArray(signal.conflicts) ? signal.conflicts.length : 0;
  const disagreementSignals = Array.isArray(signal.crossSource?.signals)
    ? signal.crossSource.signals.filter((item) => String(item.type || "").includes("DISAGREEMENT")).length
    : 0;
  const agreeingGroups = requestedDirection
    ? groups.filter((group) => grouped[group].direction === requestedDirection).length
    : 0;
  const directionalGroups = groups.filter((group) => ["LONG", "SHORT", "MIXED"].includes(grouped[group].direction)).length;

  return {
    groups,
    byGroup: grouped,
    providers: [...new Set(Object.values(grouped).flatMap((item) => item.providers))].sort(),
    combination: groups.join("+"),
    agreeingGroups,
    directionalGroups,
    conflictCount: conflicts + disagreementSignals,
  };
}

function calculateSignalConfidence(signal = {}, grouped = groupEvidence(signal)) {
  const supplied = finiteNumber(signal.confidenceScore ?? signal.confidence);
  const suppliedNormalized = supplied === null ? null : supplied > 1 ? supplied / 100 : supplied;
  const score = finiteNumber(signal.score) ?? 0;
  let confidence = suppliedNormalized === null
    ? 0.2 + Math.max(0, Math.min(0.65, score / 100 * 0.65))
    : suppliedNormalized;
  const distinctGroups = grouped.groups.filter((group) => group !== "SECURITY").length;
  const agreementBonus = Math.min(0.22, Math.max(0, distinctGroups - 1) * 0.055 + grouped.agreeingGroups * 0.025);
  confidence += agreementBonus;
  confidence -= Math.min(0.28, grouped.conflictCount * 0.07);
  if (grouped.directionalGroups > 0 && grouped.agreeingGroups === 0) confidence -= 0.12;
  const security = grouped.byGroup.SECURITY;
  if (security && security.records.some((record) => finiteNumber(record.securityRisk) >= 70)) confidence -= 0.35;
  return Number(Math.max(0, Math.min(1, confidence)).toFixed(4));
}

function deriveSignalType(signal = {}) {
  if (signal.signalType) return String(signal.signalType);
  const direction = normalizeDirection(signal.direction);
  const state = String(signal.marketState || signal.category || "").trim().replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  if (state) return state;
  return direction ? direction + "_SETUP" : "UNCLASSIFIED";
}

function deriveMarketRegime(signal = {}) {
  const explicit = signal.marketRegime || signal.regime;
  if (explicit) return String(explicit).toUpperCase();
  const state = String(signal.marketState || "").toUpperCase();
  if (state.includes("SQUEEZE")) return "SQUEEZE_RISK";
  if (state.includes("OVEREXTENDED")) return "OVEREXTENDED";
  if (state.includes("INSUFFICIENT")) return "UNKNOWN";
  return state ? state.replace(/[^A-Z0-9]+/g, "_") : "UNKNOWN";
}

function routeProviders(symbol, options = {}) {
  const assetType = String(options.assetType || "").toLowerCase();
  const hasContract = Boolean(options.contractAddress || options.tokenAddress);
  const dexAsset = assetType === "dex" || assetType === "small_dex" || options.isNewToken || hasContract;
  const providers = [];
  const add = (name) => {
    if (!providers.includes(name)) providers.push(name);
  };

  if (dexAsset) {
    add("dexscreener");
    add("geckoterminal");
    if (hasContract || options.securityCheck) {
      add("goplus");
      add("honeypot");
    }
    if (options.cexAvailable) {
      for (const provider of CEX_PROVIDERS) add(provider);
    }
  } else {
    for (const provider of CEX_PROVIDERS) add(provider);
    add("dexscreener");
    add("alternative");
    if (options.includeFred && process.env.FRED_API_KEY) add("fred");
  }

  if (options.verifiedOfficialRepository && options.repository) add("github");
  return {
    symbol: String(symbol || "").toUpperCase(),
    assetClass: dexAsset ? "DEX_TOKEN" : "CEX_PERPETUAL",
    providers,
    rationale: dexAsset
      ? "DEX and security evidence prioritized for contract-discovered assets."
      : "Derivatives, spot/orderbook, DEX cross-check and macro sentiment prioritized for perpetual assets.",
  };
}

function buildEvidenceSnapshot(signal = {}) {
  const grouped = groupEvidence(signal);
  return {
    providers: grouped.providers,
    groups: grouped.groups,
    combination: grouped.combination,
    confidenceScore: calculateSignalConfidence(signal, grouped),
    signalType: deriveSignalType(signal),
    marketRegime: deriveMarketRegime(signal),
    conflicts: Array.isArray(signal.conflicts) ? signal.conflicts.slice() : [],
    byGroup: grouped.byGroup,
  };
}

module.exports = {
  CEX_PROVIDERS,
  HORIZONS,
  PROVIDER_GROUPS,
  buildEvidenceSnapshot,
  calculateSignalConfidence,
  deriveMarketRegime,
  deriveSignalType,
  evidenceDirection,
  finiteNumber,
  getEvidenceRecords,
  groupEvidence,
  groupForProvider,
  normalizeDirection,
  normalizeProvider,
  routeProviders,
};
