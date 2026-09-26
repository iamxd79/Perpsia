"use strict";

const crypto = require("crypto");
const axios = require("axios");
const {
  CircuitBreaker,
  executeWithResilience,
} = require("../resilience");
const { increment, observe } = require("../telemetry");
const {
  buildActivity,
  exchangeLabel,
  getExchangeRegistry,
  getPriceUsd,
  makeMove,
  normalizeAssetConfigs,
} = require("../whaleAlerts");
const {
  listOnchainEvents,
  recordOnchainEvents,
} = require("../onchainStore");

const CACHE_TTL_MS = 120000;
const MAX_PAGES = 5;
const MAX_WATCHED_ADDRESSES = 20;
const activityCache = new Map();
const metadataCache = new Map();
const balanceCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function setBoundedCache(cache, key, value, expiresAt) {
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(entryKey);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { value, expiresAt });
}

const NETWORKS = {
  ethereum: { slug: "eth-mainnet", blockTimeSeconds: 12 },
  "eth-mainnet": { slug: "eth-mainnet", blockTimeSeconds: 12 },
  arbitrum: { slug: "arb-mainnet", blockTimeSeconds: 0.25 },
  "arb-mainnet": { slug: "arb-mainnet", blockTimeSeconds: 0.25 },
  base: { slug: "base-mainnet", blockTimeSeconds: 2 },
  "base-mainnet": { slug: "base-mainnet", blockTimeSeconds: 2 },
  optimism: { slug: "opt-mainnet", blockTimeSeconds: 2 },
  "opt-mainnet": { slug: "opt-mainnet", blockTimeSeconds: 2 },
  polygon: { slug: "polygon-mainnet", blockTimeSeconds: 2 },
  "polygon-mainnet": { slug: "polygon-mainnet", blockTimeSeconds: 2 },
  bnb: { slug: "bnb-mainnet", blockTimeSeconds: 3 },
  bsc: { slug: "bnb-mainnet", blockTimeSeconds: 3 },
  "bnb-mainnet": { slug: "bnb-mainnet", blockTimeSeconds: 3 },
};

const alchemyCircuitBreaker = new CircuitBreaker(4, 120000, {
  name: "Alchemy on-chain API",
});

function isEnabled(options = {}) {
  return options.enabled === true || process.env.ALCHEMY_ENABLED === "true";
}

function apiKey(options = {}) {
  return String(options.apiKey || process.env.ALCHEMY_API_KEY || "").trim();
}

function timeoutMs(options = {}) {
  return Math.max(1000, Number(options.timeoutMs || process.env.ALCHEMY_TIMEOUT_MS || 8000));
}

function normalizeNetwork(value) {
  const key = String(value || "").trim().toLowerCase();
  return NETWORKS[key] ? key : null;
}

function getAlchemyNetworks(options = {}) {
  const raw = options.networks || process.env.ALCHEMY_NETWORKS || "ethereum,base,arbitrum,bnb,polygon";
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  return [...new Set(values.map(normalizeNetwork).filter(Boolean))];
}

function unavailable(symbol, reason) {
  return {
    status: "unavailable",
    symbol: String(symbol || "UNKNOWN").replace(/^\$/, "").toUpperCase(),
    provider: "ALCHEMY",
    transactions: [],
    recentMoves: [],
    warnings: [String(reason)],
    error: String(reason),
  };
}

function parseTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rawAmount(rawValue, decimals) {
  if (!rawValue) return null;
  try {
    const raw = BigInt(String(rawValue).startsWith("0x") ? rawValue : "0x" + BigInt(rawValue).toString(16));
    const amount = Number(raw) / (10 ** Math.max(0, Number(decimals || 0)));
    return Number.isFinite(amount) ? amount : null;
  } catch {
    return null;
  }
}

function chainFromNetwork(network) {
  const value = String(network || "").toLowerCase().replace(/_/g, "-");
  if (value.includes("arbitrum") || value.includes("arb")) return "arbitrum";
  if (value.includes("base")) return "base";
  if (value.includes("optimism") || value.includes("opt")) return "optimism";
  if (value.includes("polygon")) return "polygon";
  if (value.includes("bnb") || value.includes("bsc")) return "bsc";
  return "ethereum";
}

function alchemyUrl(network, key) {
  return "https://" + NETWORKS[network].slug + ".g.alchemy.com/v2/" + key;
}

async function alchemyRpc(network, method, params, options = {}) {
  const key = apiKey(options);
  if (!key) throw new Error("ALCHEMY_API_KEY is not configured");
  const startedAt = Date.now();
  try {
    const result = await executeWithResilience(
      async () => {
        const response = await axios.post(
          alchemyUrl(network, key),
          { jsonrpc: "2.0", id: Date.now(), method, params },
          { timeout: timeoutMs(options) },
        );
        if (response?.data?.error) {
          const error = new Error(response.data.error.message || method + " failed");
          error.response = { status: response.data.error.code === -32005 ? 429 : 400 };
          throw error;
        }
        if (response?.data?.result === undefined) throw new Error(method + " returned no result");
        return response.data.result;
      },
      { breaker: alchemyCircuitBreaker, retries: 1, baseDelayMs: 300, maxDelayMs: 1500 },
    );
    increment("perpsia_onchain_requests_total", { provider: "alchemy", method, status: "success" });
    observe("perpsia_onchain_latency_ms", Date.now() - startedAt, { provider: "alchemy" });
    return result;
  } catch (error) {
    increment("perpsia_onchain_requests_total", { provider: "alchemy", method, status: error.code === "CIRCUIT_OPEN" ? "circuit_open" : "error" });
    observe("perpsia_onchain_latency_ms", Date.now() - startedAt, { provider: "alchemy" });
    throw error;
  }
}

async function fetchTokenMetadata(network, contract, options = {}) {
  const cacheKey = network + ":" + String(contract || "").toLowerCase();
  const cached = metadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await alchemyRpc(network, "alchemy_getTokenMetadata", [contract], options);
  const metadata = {
    symbol: value?.symbol || null,
    name: value?.name || null,
    decimals: Number.isInteger(Number(value?.decimals)) ? Number(value.decimals) : null,
    logo: value?.logo || null,
  };
  setBoundedCache(metadataCache, cacheKey, metadata, Date.now() + 60 * 60 * 1000);
  return metadata;
}

async function fetchTokenBalances(network, address, options = {}) {
  const cacheKey = network + ":" + String(address || "").toLowerCase();
  const cached = balanceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await alchemyRpc(network, "alchemy_getTokenBalances", [address, "erc20"], options);
  const balances = (value?.tokenBalances || []).map((item) => ({
    contractAddress: item.contractAddress || null,
    tokenBalance: item.tokenBalance || null,
    error: item.error || null,
  }));
  setBoundedCache(balanceCache, cacheKey, balances, Date.now() + 120000);
  return balances;
}

function knownAddresses(chain) {
  return getExchangeRegistry()[chain] || new Map();
}

function transferToMove(transfer, asset, chain, price, source = "ALCHEMY") {
  const from = transfer.from || transfer.fromAddress || null;
  const to = transfer.to || transfer.toAddress || null;
  const registry = knownAddresses(chain);
  const fromLabel = exchangeLabel({ [chain]: registry }, chain, from);
  const toLabel = exchangeLabel({ [chain]: registry }, chain, to);
  const decimals = Number.isInteger(Number(transfer.decimals)) ? Number(transfer.decimals) : asset.decimals;
  const amount = Number.isFinite(Number(transfer.value))
    ? Number(transfer.value)
    : rawAmount(transfer.rawValue || transfer.rawContract?.rawValue, decimals);
  const valueUsd = Number.isFinite(Number(transfer.valueUsd))
    ? Number(transfer.valueUsd)
    : Number.isFinite(amount) && Number.isFinite(Number(price)) ? amount * Number(price) : null;
  const timestamp = parseTimestamp(transfer.timestamp || transfer.metadata?.blockTimestamp);
  const hash = transfer.hash || transfer.transactionHash || null;
  const eventKey = transfer.eventKey || ["alchemy", chain, hash || "nohash", asset.address, from || "", to || "", transfer.rawValue || transfer.rawContract?.rawValue || amount || ""].join(":");
  const move = makeMove({
    hash,
    timestamp,
    asset: asset.symbol,
    amount,
    valueUsd,
    from,
    fromLabel: fromLabel || "Unknown Wallet",
    fromIsExchange: Boolean(fromLabel),
    to,
    toLabel: toLabel || "Unknown Wallet",
    toIsExchange: Boolean(toLabel),
    chain,
    source,
  });
  move.eventKey = eventKey;
  move.contractAddress = asset.address;
  move.decimals = decimals;
  return move;
}

async function fetchAssetTransfers(network, asset, options = {}) {
  const latestBlock = await alchemyRpc(network, "eth_blockNumber", [], options);
  const latest = Number.parseInt(String(latestBlock || "0x0"), 16);
  const lookbackHours = Math.max(1, Number(options.lookbackHours || 24));
  const blockCount = Math.ceil((lookbackHours * 3600) / NETWORKS[network].blockTimeSeconds);
  const fromBlock = "0x" + Math.max(0, latest - blockCount).toString(16);
  const transfers = [];
  let pageKey;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = [{
      fromBlock,
      toBlock: "latest",
      contractAddresses: [asset.address],
      category: ["erc20"],
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: "0x3e8",
      ...(pageKey ? { pageKey } : {}),
    }];
    const result = await alchemyRpc(network, "alchemy_getAssetTransfers", params, options);
    transfers.push(...(result?.transfers || []));
    pageKey = result?.pageKey;
    if (!pageKey) break;
  }
  return transfers;
}

function watchedAddresses(assets) {
  const values = [];
  for (const asset of assets || []) {
    for (const item of asset.watchedAddresses || []) values.push({ ...item, chain: asset.chain, asset: asset.symbol });
  }
  return values.slice(0, MAX_WATCHED_ADDRESSES);
}

async function collectAlchemyActivity(symbol, options = {}) {
  const normalizedSymbol = String(symbol || "").replace(/^\$/, "").toUpperCase();
  if (!isEnabled(options)) return unavailable(normalizedSymbol, "Alchemy provider is disabled.");
  if (!apiKey(options)) return unavailable(normalizedSymbol, "ALCHEMY_API_KEY is not configured.");
  const assets = options.assets || normalizeAssetConfigs(normalizedSymbol);
  const supportedAssets = assets.filter((asset) => getAlchemyNetworks(options).includes(normalizeNetwork(asset.chain)));
  if (!supportedAssets.length) return unavailable(normalizedSymbol, "No EVM asset is configured for an enabled Alchemy network.");
  const cacheKey = [normalizedSymbol, options.lookbackHours || 24, options.limit || 10, getAlchemyNetworks(options).join(",")].join(":");
  const cached = activityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const moves = [];
  const warnings = [];
  let unpricedTransfers = 0;
  const apiEvents = [];
  const prices = new Map();
  for (const asset of supportedAssets) {
    const network = normalizeNetwork(asset.chain);
    try {
      let metadata = {};
      if (asset.decimals === null || !asset.symbol) metadata = await fetchTokenMetadata(network, asset.address, options);
      const resolvedAsset = { ...asset, decimals: asset.decimals ?? metadata.decimals, symbol: asset.symbol || metadata.symbol || normalizedSymbol };
      let price = prices.get(resolvedAsset.priceSymbol);
      if (price === undefined) {
        price = await getPriceUsd(normalizedSymbol, resolvedAsset);
        prices.set(resolvedAsset.priceSymbol, price);
      }
      if (!Number.isFinite(Number(price))) unpricedTransfers += 1;
      const transfers = await fetchAssetTransfers(network, resolvedAsset, options);
      for (const transfer of transfers) {
        const move = transferToMove(transfer, resolvedAsset, network === "bnb" ? "bsc" : network, price);
        apiEvents.push({
          eventKey: move.eventKey,
          provider: "alchemy",
          chain: move.chain,
          assetSymbol: move.asset,
          contractAddress: resolvedAsset.address,
          txHash: move.hash,
          fromAddress: move.from,
          toAddress: move.to,
          amount: move.amount,
          decimals: move.decimals,
          valueUsd: move.valueUsd,
          eventTime: move.timestamp,
          payload: transfer,
        });
        moves.push(move);
      }
      for (const watched of watchedAddresses([resolvedAsset]).filter((item) => item.chain === asset.chain)) {
        try {
          await fetchTokenBalances(network, watched.address, options);
        } catch (error) {
          warnings.push(network + " watched balance: " + error.message);
        }
      }
    } catch (error) {
      warnings.push(network + ": " + error.message);
    }
  }
  const stored = listOnchainEvents({ symbol: normalizedSymbol, lookbackHours: options.lookbackHours || 24, limit: 500 });
  const seen = new Set(moves.flatMap((move) => [move.eventKey, move.hash]).filter(Boolean));
  for (const event of stored) {
    if (!event.contractAddress || seen.has(event.eventKey) || (event.txHash && seen.has(event.txHash))) continue;
    const asset = supportedAssets.find((item) => item.address.toLowerCase() === String(event.contractAddress).toLowerCase() && item.chain === event.chain);
    if (!asset) continue;
    const price = await getPriceUsd(normalizedSymbol, asset);
    const move = transferToMove({
      eventKey: event.eventKey,
      hash: event.txHash,
      from: event.fromAddress,
      to: event.toAddress,
      value: event.amount,
      valueUsd: event.valueUsd ?? (Number.isFinite(Number(event.amount)) && Number.isFinite(Number(price)) ? event.amount * price : null),
      timestamp: event.eventTime,
      decimals: event.decimals ?? asset.decimals,
    }, asset, event.chain, price, "ALCHEMY_WEBHOOK");
    moves.push(move);
    seen.add(move.eventKey || move.hash);
    if (move.hash) seen.add(move.hash);
  }
  if (apiEvents.length) recordOnchainEvents(apiEvents);
  const result = buildActivity(normalizedSymbol, moves, {
    ...options,
    provider: "ALCHEMY",
    sourceType: "rest",
  }, warnings, unpricedTransfers, assets);
  result.watchedAddresses = watchedAddresses(assets);
  result.networks = getAlchemyNetworks(options);
  setBoundedCache(activityCache, cacheKey, result, Date.now() + CACHE_TTL_MS);
  increment("perpsia_onchain_events_total", { provider: "alchemy", status: moves.length ? "ok" : "empty" }, moves.length || 1);
  return result;
}

async function collectAlchemyEvidence(context = {}) {
  const activity = await collectAlchemyActivity(context.symbol, context);
  return activity.evidence || {
    provider: "alchemy",
    symbol: context.symbol,
    marketType: "onchain",
    status: "unavailable",
    error: activity.error || activity.warnings?.[0] || "Alchemy unavailable",
    metadata: { evidenceGroup: "ONCHAIN" },
  };
}

function parseAddressActivityPayload(payload = {}) {
  const defaultChain = chainFromNetwork(payload.network || payload.webhook?.network);
  return (Array.isArray(payload.activity) ? payload.activity : []).map((item, index) => {
    const chain = chainFromNetwork(item.network || payload.network || defaultChain);
    const contractAddress = item.rawContract?.address || item.contractAddress || null;
    const eventKey = item.hash
      ? ["alchemy", chain, item.hash, contractAddress || "native", item.fromAddress || item.from || "", item.toAddress || item.to || "", item.rawContract?.rawValue || item.value || index].join(":")
      : ["alchemy-webhook", payload.id || payload.webhookId || "unknown", index, contractAddress || "native"].join(":");
    const assetSymbol = item.asset || item.rawContract?.symbol || null;
    return {
      eventKey,
      provider: "alchemy_webhook",
      chain,
      assetSymbol,
      contractAddress,
      txHash: item.hash || item.transactionHash || null,
      fromAddress: item.fromAddress || item.from || null,
      toAddress: item.toAddress || item.to || null,
      amount: Number.isFinite(Number(item.value)) ? Number(item.value) : null,
      decimals: Number.isInteger(Number(item.rawContract?.decimals)) ? Number(item.rawContract.decimals) : null,
      valueUsd: null,
      eventTime: parseTimestamp(item.metadata?.blockTimestamp || payload.createdAt),
      payload: item,
    };
  }).filter((item) => item.contractAddress || item.txHash);
}

function verifyAlchemySignature(rawBody, signature, signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY) {
  const key = String(signingKey || "");
  const provided = String(signature || "").trim().toLowerCase();
  if (!key || !provided || !rawBody) return false;
  const expected = crypto.createHmac("sha256", key).update(Buffer.from(String(rawBody), "utf8")).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function recordAlchemyWebhook(payload) {
  const events = parseAddressActivityPayload(payload);
  const result = recordOnchainEvents(events);
  increment("perpsia_onchain_webhook_events_total", { provider: "alchemy", status: "accepted" }, result.inserted);
  increment("perpsia_onchain_webhook_duplicates_total", { provider: "alchemy" }, result.duplicates);
  activityCache.clear();
  return { ...result, events: events.length };
}

function getAlchemyHealth() {
  return {
    provider: "alchemy",
    enabled: isEnabled(),
    configured: Boolean(apiKey()),
    networks: getAlchemyNetworks(),
    cacheEntries: activityCache.size,
    circuit: alchemyCircuitBreaker.snapshot(),
  };
}

function clearAlchemyCache() {
  activityCache.clear();
  metadataCache.clear();
  balanceCache.clear();
}

module.exports = {
  collectAlchemyActivity,
  collectAlchemyEvidence,
  fetchTokenBalances,
  fetchTokenMetadata,
  getAlchemyHealth,
  getAlchemyNetworks,
  parseAddressActivityPayload,
  recordAlchemyWebhook,
  verifyAlchemySignature,
  clearAlchemyCache,
};
