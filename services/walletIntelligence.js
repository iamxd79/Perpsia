"use strict";

const { listOnchainEvents } = require("./onchainStore");
const {
  getWalletByAddress,
  linkWalletEvent,
  listWallets,
  normalizeAddress,
  normalizeChain,
  upsertListingWatchEvent,
} = require("./walletRegistry");
const { increment } = require("./telemetry");

const WINDOW_MS = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function symbolOf(value) {
  return String(value || "").replace(/^\$/, "").trim().toUpperCase();
}

function eventIdentity(event = {}) {
  return [
    String(event.chain || "").toLowerCase(),
    String(event.txHash || event.hash || event.eventKey || ""),
    normalizeAddress(event.contractAddress),
    normalizeAddress(event.fromAddress || event.from),
    normalizeAddress(event.toAddress || event.to),
    String(event.amount ?? ""),
  ].join("|");
}

function dedupeEvents(events = []) {
  const seen = new Set();
  return (Array.isArray(events) ? events : []).filter((event) => {
    const key = eventIdentity(event);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function walletRole(wallet) {
  if (!wallet) return null;
  const category = String(wallet.category || "").toLowerCase();
  if (wallet.exchange || category.startsWith("exchange_") || category === "listing_watch") return "exchange";
  if (category === "smart_money") return "smart_money";
  if (category === "kol") return "kol";
  if (["team", "treasury", "market_maker", "fund", "deployer"].includes(category)) return category;
  return "tracked_wallet";
}

function describeEvent(event, walletMap) {
  const from = walletMap.get(normalizeAddress(event.fromAddress || event.from)) || null;
  const to = walletMap.get(normalizeAddress(event.toAddress || event.to)) || null;
  const valueUsd = finite(event.valueUsd);
  const amount = finite(event.amount);
  return {
    ...event,
    chain: normalizeChain(event.chain),
    symbol: symbolOf(event.assetSymbol || event.symbol),
    fromWallet: from,
    toWallet: to,
    fromRole: walletRole(from),
    toRole: walletRole(to),
    value: valueUsd ?? amount ?? 0,
    valueUsd,
  };
}

function windowEvents(events, windowKey, endAt) {
  const cutoff = endAt - WINDOW_MS[windowKey];
  return events.filter((event) => Number(event.eventTime || event.timestamp || 0) >= cutoff && Number(event.eventTime || event.timestamp || 0) <= endAt);
}

function flowFor(events, predicate) {
  return Number(events.filter(predicate).reduce((sum, event) => sum + Math.max(0, Number(event.value || 0)), 0).toFixed(6));
}

function summarizeWindow(events) {
  const exchangeInflow = flowFor(events, (event) => event.toRole === "exchange");
  const exchangeOutflow = flowFor(events, (event) => event.fromRole === "exchange");
  const smartMoneyIn = flowFor(events, (event) => event.toRole === "smart_money");
  const smartMoneyOut = flowFor(events, (event) => event.fromRole === "smart_money");
  const kolIn = flowFor(events, (event) => event.toRole === "kol");
  const kolOut = flowFor(events, (event) => event.fromRole === "kol");
  const smartBuyers = new Set(events.filter((event) => event.toRole === "smart_money").map((event) => event.toWallet?.address).filter(Boolean));
  const smartSellers = new Set(events.filter((event) => event.fromRole === "smart_money").map((event) => event.fromWallet?.address).filter(Boolean));
  const exchangeDepositors = new Set(events.filter((event) => event.toRole === "exchange").map((event) => event.fromAddress).filter(Boolean));
  const repeatedBuys = new Map();
  const repeatedSells = new Map();
  for (const event of events) {
    if (event.toRole === "smart_money" && event.toWallet?.address) repeatedBuys.set(event.toWallet.address, (repeatedBuys.get(event.toWallet.address) || 0) + 1);
    if (event.fromRole === "smart_money" && event.fromWallet?.address) repeatedSells.set(event.fromWallet.address, (repeatedSells.get(event.fromWallet.address) || 0) + 1);
  }
  const uniqueConvergingWallets = new Set([...smartBuyers, ...smartSellers]);
  const totalSmartFlow = smartMoneyIn + smartMoneyOut;
  const accumulationScore = totalSmartFlow > 0 ? Number(((smartMoneyIn - smartMoneyOut) / totalSmartFlow * 100).toFixed(2)) : null;
  const distributionScore = totalSmartFlow > 0 ? Number(((smartMoneyOut - smartMoneyIn) / totalSmartFlow * 100).toFixed(2)) : null;
  const qualityValues = [...uniqueConvergingWallets]
    .map((address) => events.find((event) => event.fromWallet?.address === address || event.toWallet?.address === address)?.fromWallet?.address === address
      ? events.find((event) => event.fromWallet?.address === address)?.fromWallet
      : events.find((event) => event.toWallet?.address === address)?.toWallet)
    .map((wallet) => finite(wallet?.qualityScore))
    .filter((score) => score !== null);
  const weightedWalletQuality = qualityValues.length
    ? Number((qualityValues.reduce((sum, score) => sum + score, 0) / qualityValues.length).toFixed(2))
    : null;
  const smartMoneyConvergenceScore = uniqueConvergingWallets.size
    ? Number(Math.min(100, uniqueConvergingWallets.size * 15 + (weightedWalletQuality || 0) * 0.4 + [...repeatedBuys.values()].filter((count) => count > 1).length * 5).toFixed(2))
    : 0;
  return {
    transferCount: events.length,
    exchangeInflow,
    exchangeOutflow,
    exchangeClusterNetFlow: Number((exchangeInflow - exchangeOutflow).toFixed(6)),
    smartMoneyNetFlow: Number((smartMoneyIn - smartMoneyOut).toFixed(6)),
    kolNetFlow: Number((kolIn - kolOut).toFixed(6)),
    smartMoneyIn,
    smartMoneyOut,
    kolIn,
    kolOut,
    uniqueTrackedBuyers: smartBuyers.size,
    uniqueTrackedSellers: smartSellers.size,
    uniqueDepositors: exchangeDepositors.size,
    repeatedBuyCount: [...repeatedBuys.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0),
    repeatedSellCount: [...repeatedSells.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0),
    walletConvergence: uniqueConvergingWallets.size,
    smartMoneyConvergenceScore,
    smartMoneyBuyerCount: smartBuyers.size,
    smartMoneySellerCount: smartSellers.size,
    weightedWalletQuality,
    accumulationScore,
    distributionScore,
  };
}

function acceleration(events, endAt) {
  const current = windowEvents(events, "15m", endAt);
  const previous = events.filter((event) => {
    const time = Number(event.eventTime || 0);
    return time >= endAt - 30 * 60 * 1000 && time < endAt - 15 * 60 * 1000;
  });
  const currentFlow = current.reduce((sum, event) => sum + Math.max(0, Number(event.value || 0)), 0);
  const previousFlow = previous.reduce((sum, event) => sum + Math.max(0, Number(event.value || 0)), 0);
  return {
    current15m: Number(currentFlow.toFixed(6)),
    previous15m: Number(previousFlow.toFixed(6)),
    ratio: previousFlow > 0 ? Number((currentFlow / previousFlow).toFixed(4)) : currentFlow > 0 ? null : 0,
    change: previousFlow > 0 ? Number((currentFlow / previousFlow - 1).toFixed(4)) : null,
  };
}

function levelFor(score) {
  if (score >= 5) return "HIGH";
  if (score >= 4) return "ELEVATED";
  if (score >= 2) return "WATCH";
  return "LOW";
}

function buildListingWatch(symbol, chain, events, windows, accelerationData, options = {}) {
  const exchanges = new Map();
  for (const event of events.filter((item) => item.toRole === "exchange" && item.toWallet?.exchange)) {
    const exchange = itemExchange(event.toWallet);
    const existing = exchanges.get(exchange) || { exchange, events: [], depositors: new Set(), treasury: false, marketMaker: false, firstSeenTokenAtExchange: false };
    existing.events.push(event);
    if (event.fromAddress) existing.depositors.add(event.fromAddress);
    if (["team", "treasury"].includes(event.fromRole)) existing.treasury = true;
    if (event.fromRole === "market_maker") existing.marketMaker = true;
    existing.firstSeenTokenAtExchange = true;
    exchanges.set(exchange, existing);
  }
  const watches = [];
  for (const item of exchanges.values()) {
    const observations = [];
    let score = 0;
    if (item.firstSeenTokenAtExchange) { observations.push("Token observed in a verified exchange cluster"); score += 2; }
    if ((accelerationData.change || 0) > 0.5) { observations.push("Deposits accelerating"); score += 1; }
    if (item.treasury) { observations.push("Treasury/team-linked transfer detected"); score += 1; }
    if (item.marketMaker) { observations.push("Market-maker-linked transfer detected"); score += 1; }
    if (item.events.length > 1) { observations.push("Repeated deposits detected"); score += 1; }
    if (item.depositors.size > 1) { observations.push("Multiple depositors detected"); score += 1; }
    const level = levelFor(score);
    const officialConfirmation = options.officialListingConfirmation === true && options.officialListingSource === "official_exchange";
    const result = upsertListingWatchEvent({
      eventKey: [symbol, chain, item.exchange, item.events[0]?.contractAddress || "unknown"].join(":"),
      symbol,
      chain,
      contractAddress: item.events[0]?.contractAddress || null,
      exchange: item.exchange,
      level,
      observations,
      sources: [...new Set(item.events.map((event) => event.provider).filter(Boolean))],
      officialConfirmation,
      eventType: officialConfirmation ? "LISTING_CONFIRMED" : "LISTING_WATCH",
    });
    watches.push({
      type: officialConfirmation ? "LISTING_CONFIRMED" : "LISTING_WATCH",
      exchange: item.exchange,
      token: symbol,
      chain,
      level,
      observations,
      officialConfirmation,
      stored: result,
      windows,
    });
    increment("listing_watch_events_total", { level, type: officialConfirmation ? "confirmed" : "watch" });
  }
  return watches;
}

function itemExchange(wallet) {
  return String(wallet?.exchange || wallet?.label || "Unknown Exchange");
}

function analyzeWalletActivity(symbol, options = {}) {
  const normalizedSymbol = symbolOf(symbol);
  const chain = normalizeChain(options.chain || options.network);
  const registry = listWallets({ enabled: true, ...(chain ? { chain } : {}) });
  const walletMap = new Map(registry.map((wallet) => [normalizeAddress(wallet.address), wallet]));
  const rawEvents = Array.isArray(options.events)
    ? options.events
    : listOnchainEvents({ symbol: normalizedSymbol, chain, lookbackHours: options.lookbackHours || 24, limit: options.limit || 1000 });
  const described = dedupeEvents(rawEvents)
    .map((event) => describeEvent(event, walletMap))
    .filter((event) => !normalizedSymbol || !event.symbol || event.symbol === normalizedSymbol)
    .filter((event) => !chain || event.chain === chain);
  const endAt = Number(options.now || Date.now());
  const windows = Object.fromEntries(Object.keys(WINDOW_MS).map((key) => [key, summarizeWindow(windowEvents(described, key, endAt))]));
  const flowAcceleration = acceleration(described, endAt);
  const listingWatch = buildListingWatch(normalizedSymbol, chain || described[0]?.chain || "unknown", described, windows, flowAcceleration, options);
  const walletLinks = [];
  for (const event of described) {
    for (const [relation, wallet] of [["from", event.fromWallet], ["to", event.toWallet]]) {
      if (!wallet) continue;
      linkWalletEvent(event.eventKey || event.txHash, wallet.id, relation, { token: normalizedSymbol, direction: relation === "to" ? "IN" : "OUT", metadata: { provider: event.provider, txHash: event.txHash } });
      walletLinks.push({ eventKey: event.eventKey, walletId: wallet.id, relation, wallet: wallet.address });
    }
  }
  if (described.length) increment("wallet_events_total", { status: "observed" }, described.length);
  if (windows["24h"].walletConvergence > 1) increment("wallet_convergence_events_total", { symbol: normalizedSymbol });
  if (windows["24h"].smartMoneyNetFlow !== 0) increment("smart_money_events_total", { symbol: normalizedSymbol });
  if (windows["24h"].exchangeInflow !== 0 || windows["24h"].exchangeOutflow !== 0) increment("exchange_flow_events_total", { symbol: normalizedSymbol });
  return {
    status: described.length ? "available" : "insufficient_data",
    symbol: normalizedSymbol,
    chain: chain || described[0]?.chain || null,
    eventCount: described.length,
    windows,
    flowAcceleration,
    newTokenExposure: described.some((event) => event.toRole === "smart_money" || event.toRole === "kol"),
    listingWatch,
    walletLinks,
    providers: [...new Set(described.map((event) => event.provider).filter(Boolean))],
    freshness: described.length ? { fetchedAt: Math.max(...described.map((event) => Number(event.eventTime || 0))), stale: false, freshnessClass: "live" } : { fetchedAt: null, stale: true, freshnessClass: "missing" },
  };
}

function buildWalletEvidence(symbol, options = {}) {
  const activity = analyzeWalletActivity(symbol, options);
  if (activity.status !== "available") {
    return {
      provider: "wallet_intelligence",
      symbol: activity.symbol,
      marketType: "onchain",
      status: "insufficient_data",
      sourceType: "sqlite",
      timestamp: Date.now(),
      metadata: { evidenceGroup: "ONCHAIN", type: "WALLET_INTELLIGENCE", freshnessClass: "missing", stale: true, usable: false, reason: "No canonical wallet events available." },
    };
  }
  const latest = activity.windows["24h"];
  return {
    provider: "wallet_intelligence",
    symbol: activity.symbol,
    chain: activity.chain,
    marketType: "onchain",
    sourceType: "sqlite",
    timestamp: activity.freshness.fetchedAt || Date.now(),
    status: "ok",
    sourceConfidence: 0.82,
    metadata: {
      evidenceGroup: "ONCHAIN",
      type: "WALLET_INTELLIGENCE",
      walletCategories: ["smart_money", "kol", "exchange_*", "team", "treasury", "market_maker"],
      windows: activity.windows,
      smartMoneyNetFlow: latest.smartMoneyNetFlow,
      kolNetFlow: latest.kolNetFlow,
      exchangeInflow: latest.exchangeInflow,
      exchangeOutflow: latest.exchangeOutflow,
      exchangeClusterNetFlow: latest.exchangeClusterNetFlow,
      walletConvergence: latest.walletConvergence,
      smartMoneyConvergenceScore: latest.smartMoneyConvergenceScore,
      smartMoneyBuyerCount: latest.smartMoneyBuyerCount,
      smartMoneySellerCount: latest.smartMoneySellerCount,
      weightedWalletQuality: latest.weightedWalletQuality,
      repeatedBuyCount: latest.repeatedBuyCount,
      repeatedSellCount: latest.repeatedSellCount,
      uniqueTrackedBuyers: latest.uniqueTrackedBuyers,
      uniqueTrackedSellers: latest.uniqueTrackedSellers,
      accumulationScore: latest.accumulationScore,
      distributionScore: latest.distributionScore,
      flowAcceleration: activity.flowAcceleration,
      newTokenExposure: activity.newTokenExposure,
      listingWatch: activity.listingWatch,
      providers: activity.providers,
      attribution: { alchemy: activity.providers.includes("alchemy") || activity.providers.includes("alchemy_webhook"), gmgn: activity.providers.includes("gmgn") },
      freshness: activity.freshness,
      stale: false,
      usable: true,
      reason: "Deterministic wallet and exchange flow features from canonical registry-linked events.",
    },
  };
}

module.exports = {
  analyzeWalletActivity,
  buildWalletEvidence,
  dedupeEvents,
  eventIdentity,
};
