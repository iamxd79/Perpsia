"use strict";

const QUALITY_TIERS = Object.freeze(["LOW", "WATCH", "QUALITY", "HIGH_QUALITY", "ELITE"]);
const SUPPORTED_ALCHEMY_CHAINS = new Set(["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc"]);
const DEFAULT_THRESHOLDS = Object.freeze({ low: 40, watch: 60, quality: 75, highQuality: 90 });

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value)));
}

function ratio(value) {
  const numeric = finite(value);
  if (numeric === null) return null;
  return clamp(numeric > 1 ? numeric : numeric * 100);
}

function inverseRatio(value) {
  const normalized = ratio(value);
  return normalized === null ? null : 100 - normalized;
}

function recentActivityScore(value, now = Date.now()) {
  const numeric = finite(value);
  if (numeric === null) return null;
  if (numeric >= 0 && numeric <= 1) return numeric * 100;
  if (numeric >= 0 && numeric <= 100) return numeric;
  const timestamp = numeric < 100000000000 ? numeric * 1000 : numeric;
  const ageDays = Math.max(0, (now - timestamp) / 86400000);
  return clamp(100 * Math.exp(-ageDays / 30));
}

function pnlScore(value) {
  const numeric = finite(value);
  if (numeric === null) return null;
  return clamp(50 + 50 * Math.tanh(numeric / 10000));
}

function countScore(value, ceiling) {
  const numeric = finite(value);
  return numeric === null ? null : clamp((Math.max(0, numeric) / ceiling) * 100);
}

function freshnessScore(value, now = Date.now()) {
  const numeric = finite(value);
  if (numeric === null) return null;
  if (numeric >= 0 && numeric <= 1) return numeric * 100;
  const timestamp = numeric < 100000000000 ? numeric * 1000 : numeric;
  const ageHours = Math.max(0, (now - timestamp) / 3600000);
  return clamp(100 * Math.exp(-ageHours / 72));
}

function extractQualityMetrics(record = {}) {
  const nested = record.qualityMetrics || record.quality_metrics || record.performanceMetadata || record.performance_metadata || {};
  return {
    realizedPnl: finite(record.realizedPnl ?? record.realized_pnl ?? record.pnl ?? record.realized_profit ?? nested.realizedPnl ?? nested.realized_pnl ?? nested.pnl),
    winRate: ratio(record.winRate ?? record.win_rate ?? nested.winRate ?? nested.win_rate),
    profitableTradeRatio: ratio(record.profitableTradeRatio ?? record.profitable_trade_ratio ?? nested.profitableTradeRatio ?? nested.profitable_trade_ratio),
    tradeCount: finite(record.tradeCount ?? record.trade_count ?? nested.tradeCount ?? nested.trade_count),
    recentActivity: recentActivityScore(record.recentActivity ?? record.recent_activity ?? record.lastActive ?? record.last_active ?? nested.recentActivity ?? nested.recent_activity),
    averageEntryTiming: ratio(record.averageEntryTiming ?? record.average_entry_timing ?? nested.averageEntryTiming ?? nested.average_entry_timing),
    earlyEntryFrequency: ratio(record.earlyEntryFrequency ?? record.early_entry_frequency ?? nested.earlyEntryFrequency ?? nested.early_entry_frequency),
    rugExposure: ratio(record.rugExposure ?? record.rug_exposure ?? nested.rugExposure ?? nested.rug_exposure),
    tokenDiversity: finite(record.tokenDiversity ?? record.token_diversity ?? nested.tokenDiversity ?? nested.token_diversity),
    drawdown: ratio(record.drawdown ?? nested.drawdown),
    consistency: ratio(record.consistency ?? nested.consistency),
    dataFreshness: freshnessScore(record.dataFreshness ?? record.data_freshness ?? record.lastActive ?? record.last_active ?? nested.dataFreshness ?? nested.data_freshness),
  };
}

function calculateWalletQuality(metrics = {}) {
  const components = [
    ["realizedPnl", pnlScore(metrics.realizedPnl), 15],
    ["winRate", ratio(metrics.winRate), 15],
    ["profitableTradeRatio", ratio(metrics.profitableTradeRatio), 10],
    ["tradeCount", countScore(metrics.tradeCount, 100), 10],
    ["recentActivity", finite(metrics.recentActivity), 10],
    ["averageEntryTiming", ratio(metrics.averageEntryTiming), 8],
    ["earlyEntryFrequency", ratio(metrics.earlyEntryFrequency), 8],
    ["rugExposure", inverseRatio(metrics.rugExposure), 8],
    ["tokenDiversity", countScore(metrics.tokenDiversity, 20), 5],
    ["drawdown", inverseRatio(metrics.drawdown), 6],
    ["consistency", ratio(metrics.consistency), 3],
    ["dataFreshness", finite(metrics.dataFreshness), 2],
  ].filter(([, score]) => score !== null);
  if (!components.length) return { score: null, tier: "UNASSESSED", components: {}, observedComponentCount: 0 };
  const weight = components.reduce((sum, [, , itemWeight]) => sum + itemWeight, 0);
  const score = components.reduce((sum, [, itemScore, itemWeight]) => sum + itemScore * itemWeight, 0) / weight;
  const componentScores = Object.fromEntries(components.map(([name, itemScore]) => [name, Number(itemScore.toFixed(2))]));
  return {
    score: Number(clamp(score).toFixed(2)),
    tier: qualityTier(score),
    components: componentScores,
    observedComponentCount: components.length,
  };
}

function thresholds() {
  return {
    low: finite(process.env.PERPSIA_WALLET_QUALITY_LOW) ?? DEFAULT_THRESHOLDS.low,
    watch: finite(process.env.PERPSIA_WALLET_QUALITY_WATCH) ?? DEFAULT_THRESHOLDS.watch,
    quality: finite(process.env.PERPSIA_WALLET_QUALITY_QUALITY) ?? DEFAULT_THRESHOLDS.quality,
    highQuality: finite(process.env.PERPSIA_WALLET_QUALITY_HIGH) ?? DEFAULT_THRESHOLDS.highQuality,
  };
}

function qualityTier(score) {
  const numeric = finite(score);
  if (numeric === null) return "UNASSESSED";
  const limits = thresholds();
  if (numeric >= limits.highQuality) return "ELITE";
  if (numeric >= limits.quality) return "HIGH_QUALITY";
  if (numeric >= limits.watch) return "QUALITY";
  if (numeric >= limits.low) return "WATCH";
  return "LOW";
}

function isVerified(status) {
  return ["official", "verified", "manual_approved"].includes(String(status || "").toLowerCase());
}

function isAlchemyEligible(chain, address) {
  return SUPPORTED_ALCHEMY_CHAINS.has(String(chain || "").toLowerCase()) && /^0x[a-f0-9]{40}$/i.test(String(address || ""));
}

function monitoringPriority(wallet = {}) {
  const status = String(wallet.verificationStatus || wallet.verification_status || "").toLowerCase();
  if (status === "rejected") return 0;
  const verified = isVerified(status);
  const category = String(wallet.category || "").toLowerCase();
  const role = String(wallet.role || "").toLowerCase();
  if (wallet.exchange || category.startsWith("exchange_") || category === "listing_watch") {
    if (!verified) return status === "pending" ? 20 : 10;
    if (["exchange_deposit", "exchange_aggregation", "exchange_hot"].includes(category) || ["deposit", "aggregation", "hot"].includes(role)) return 100;
    if (["exchange_cold", "exchange_treasury", "listing_watch"].includes(category) || ["cold", "treasury", "listing_watch"].includes(role)) return 90;
    return 80;
  }
  if (category === "smart_money") {
    if (wallet.qualityTier === "ELITE") return 90;
    if (wallet.qualityTier === "HIGH_QUALITY") return 80;
    if (wallet.qualityTier === "QUALITY") return 50;
    return verified ? 40 : 20;
  }
  if (category === "kol") return verified ? 60 : 20;
  if (["market_maker", "fund", "treasury", "team", "protocol"].includes(category)) return verified ? 70 : 20;
  if (category === "whale") return verified ? 40 : 15;
  return verified ? 30 : 10;
}

function enrichWalletQuality(record = {}, options = {}) {
  const metrics = extractQualityMetrics(record);
  const quality = calculateWalletQuality(metrics);
  const enriched = {
    ...record,
    qualityMetrics: metrics,
    qualityScore: quality.score,
    qualityTier: quality.tier,
  };
  enriched.monitoringPriority = monitoringPriority(enriched);
  return { ...quality, monitoringPriority: enriched.monitoringPriority, metrics, wallet: enriched };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  QUALITY_TIERS,
  SUPPORTED_ALCHEMY_CHAINS: [...SUPPORTED_ALCHEMY_CHAINS],
  calculateWalletQuality,
  enrichWalletQuality,
  extractQualityMetrics,
  isAlchemyEligible,
  isVerified,
  monitoringPriority,
  qualityTier,
};
