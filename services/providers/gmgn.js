"use strict";

const crypto = require("crypto");
const axios = require("axios");
const { CircuitBreaker, executeWithResilience } = require("../resilience");
const { increment, observe } = require("../telemetry");
const { importGmgnWallets } = require("../walletRegistry");

const DEFAULT_HOST = "https://openapi.gmgn.ai";
const CACHE_TTL_MS = 60000;
const MAX_LIST_ITEMS = 20;
const cache = new Map();
const MAX_CACHE_ENTRIES = 500;
const gmgnCircuitBreaker = new CircuitBreaker(4, 120000, { name: "GMGN read-only API" });

const READ_ONLY_ENDPOINTS = Object.freeze({
  tokenInfo: "/v1/token/info",
  tokenSecurity: "/v1/token/security",
  tokenPool: "/v1/token/pool_info",
  tokenHolders: "/v1/market/token_top_holders",
  tokenTraders: "/v1/market/token_top_traders",
  marketTrending: "/v1/market/rank",
  marketTrenches: "/v1/trenches",
  smartMoney: "/v1/user/smartmoney",
  walletActivity: "/v1/user/wallet_activity",
  walletStats: "/v1/user/wallet_stats",
});

function isEnabled(options = {}) {
  return options.enabled === true || process.env.GMGN_ENABLED === "true";
}

function apiKey(options = {}) {
  return String(options.apiKey || process.env.GMGN_API_KEY || "").trim();
}

function timeoutMs(options = {}) {
  return Math.max(1000, Number(options.timeoutMs || process.env.GMGN_TIMEOUT_MS || 8000));
}

function host(options = {}) {
  return String(options.host || process.env.GMGN_API_HOST || DEFAULT_HOST).replace(/\/$/, "");
}

function normalizedChain(value) {
  const chain = String(value || "").trim().toLowerCase();
  const aliases = { ethereum: "eth", mainnet: "eth", solana: "sol", bsc: "bsc", binance: "bsc" };
  return aliases[chain] || chain;
}

function stableQueryKey(path, query) {
  return path + "?" + Object.entries(query || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => (Array.isArray(value) ? value.map((item) => [key, item]) : [[key, value]]))
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(String(value)))
    .join("&");
}

function buildQuery(query = {}) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((item) => result.append(key, String(item)));
    else result.set(key, String(value));
  }
  return result;
}

function authenticatedQuery(query = {}) {
  return {
    ...query,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: crypto.randomUUID(),
  };
}

function retryAfterMs(response) {
  const raw = response?.headers?.["x-ratelimit-reset"] || response?.headers?.["retry-after"];
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return numeric > 1000000000 ? Math.max(0, numeric * 1000 - Date.now()) : Math.max(0, numeric * 1000);
}

async function request(method, path, query = {}, body = null, options = {}) {
  const key = apiKey(options);
  if (!key) throw new Error("GMGN_API_KEY is not configured");
  const startedAt = Date.now();
  try {
    const result = await executeWithResilience(async () => {
      const authenticated = authenticatedQuery(query);
      const response = await axios.request({
        method,
        url: host(options) + path,
        params: authenticated,
        data: body,
        timeout: timeoutMs(options),
        headers: {
          "X-APIKEY": key,
          "Content-Type": "application/json",
          "User-Agent": "perpsia-gmgn-readonly/1.0",
        },
        validateStatus: () => true,
      });
      if (Number(response.status) === 429) {
        const error = new Error("GMGN rate limit reached");
        error.response = { status: 429, headers: response.headers };
        error.retryAfterMs = retryAfterMs(response);
        throw error;
      }
      if (Number(response.status) >= 400) {
        const error = new Error("GMGN request failed with HTTP " + response.status);
        error.response = { status: response.status, headers: response.headers };
        throw error;
      }
      const payload = response.data;
      const code = payload && typeof payload === "object" ? payload.code : 0;
      if (code !== undefined && String(code) !== "0") {
        const error = new Error("GMGN API returned an error");
        error.response = { status: 400, headers: response.headers };
        error.gmgnCode = code;
        throw error;
      }
      return payload?.data ?? payload;
    }, { breaker: gmgnCircuitBreaker, retries: 1, baseDelayMs: 300, maxDelayMs: 1500 });
    increment("perpsia_onchain_requests_total", { provider: "gmgn", method: path, status: "success" });
    observe("perpsia_onchain_latency_ms", Date.now() - startedAt, { provider: "gmgn" });
    return result;
  } catch (error) {
    increment("perpsia_onchain_requests_total", { provider: "gmgn", method: path, status: error.code === "CIRCUIT_OPEN" ? "circuit_open" : "error" });
    observe("perpsia_onchain_latency_ms", Date.now() - startedAt, { provider: "gmgn" });
    throw error;
  }
}

async function cachedRequest(method, path, query, body, options = {}) {
  const cacheKey = stableQueryKey(path, { method, ...(query || {}), body: body ? JSON.stringify(body) : "" });
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await request(method, path, query, body, options);
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(entryKey);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asList(value) {
  if (Array.isArray(value)) return value;
  const object = asObject(value);
  for (const key of ["list", "rows", "items", "tokens", "holders", "traders", "activities", "data"]) {
    if (Array.isArray(object[key])) return object[key];
  }
  return [];
}

function firstNumber(objects, keys) {
  for (const object of objects) {
    const source = asObject(object);
    for (const key of keys) {
      const value = Number(source[key]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function compactWallet(item) {
  const object = asObject(item);
  return {
    address: object.address || object.wallet_address || object.walletAddress || null,
    tag: object.tag || object.tags || null,
    pnl: object.pnl ?? object.realized_profit ?? object.profit_change ?? null,
    realizedPnl: object.realized_pnl ?? object.realized_profit ?? object.pnl ?? null,
    winRate: object.win_rate ?? object.winrate ?? null,
    profitableTradeRatio: object.profitable_trade_ratio ?? object.profit_trade_ratio ?? null,
    tradeCount: object.trade_count ?? object.tx_count ?? object.total_trades ?? null,
    buyVolume: object.buy_volume_cur ?? object.buy_volume_24h ?? null,
    sellVolume: object.sell_volume_cur ?? object.sell_volume_24h ?? null,
    lastActive: object.last_active_timestamp ?? object.last_active_time ?? null,
    averageEntryTiming: object.average_entry_timing ?? object.avg_entry_timing ?? null,
    earlyEntryFrequency: object.early_entry_frequency ?? object.early_entries_ratio ?? null,
    rugExposure: object.rug_exposure ?? object.rug_ratio ?? null,
    tokenDiversity: object.token_diversity ?? object.unique_tokens ?? null,
    drawdown: object.drawdown ?? object.max_drawdown ?? null,
    consistency: object.consistency ?? object.consistency_score ?? null,
    dataFreshness: object.updated_at ?? object.last_active_timestamp ?? null,
    publicIdentityReference: object.profile_url || object.profileUrl || null,
  };
}

function isMatchingToken(item, address) {
  const target = String(address || "").toLowerCase();
  const object = asObject(item);
  return [object.token_address, object.tokenAddress, object.address, object.token?.address]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase() === target);
}

function securityRisk(security) {
  const object = asObject(security);
  const explicit = firstNumber([object], ["risk_score", "riskScore", "security_score"]);
  if (explicit !== null) return Math.max(0, Math.min(100, explicit));
  const hardRisk = ["is_honeypot", "is_blacklisted", "is_mintable", "is_freezeable"]
    .filter((key) => object[key] === true || String(object[key]).toLowerCase() === "yes").length;
  return hardRisk ? Math.min(100, 25 * hardRisk) : null;
}

function availableRecord(symbol, chain, address, responses, warnings, options = {}) {
  const info = asObject(responses.info);
  const security = asObject(responses.security);
  const pool = asObject(responses.pool);
  const holders = asList(responses.holders);
  const traders = asList(responses.traders);
  const smartHolders = holders.filter((item) => /smart_degen|smart_money/i.test(JSON.stringify(item?.tag || item?.tags || "")));
  const smartTraders = traders.filter((item) => /smart_degen|smart_money/i.test(JSON.stringify(item?.tag || item?.tags || "")));
  const smartMoneyFeed = asList(responses.smartMoney).filter((item) => isMatchingToken(item, address));
  const price = firstNumber([info, info.price, info.price_info], ["price", "price_usd", "usd_price"]);
  const volume = firstNumber([info, info.price, pool], ["volume_24h", "volume_1h", "volume", "volume_usd"]);
  const liquidity = firstNumber([info, pool], ["liquidity", "liquidity_usd", "pool_liquidity"]);
  const holderCount = firstNumber([info], ["holder_count", "holders", "holder_num"]);
  const timestamp = firstNumber([info, pool], ["updated_at", "update_time", "timestamp"]) || Date.now();
  const featureSources = Object.entries(responses).filter(([, value]) => value !== null && value !== undefined).map(([name]) => name);
  const walletRows = [...smartHolders, ...smartTraders, ...smartMoneyFeed]
    .map(compactWallet)
    .filter((item, index, rows) => item.address && rows.findIndex((candidate) => candidate.address === item.address) === index)
    .slice(0, MAX_LIST_ITEMS);
  const gmgnImport = options.persistWallets === false ? { imported: [], rejected: [] } : importGmgnWallets(walletRows.map((wallet) => ({
      ...wallet,
      chain,
      category: /kol|ct|influencer/i.test(String(wallet.tag || "")) ? "kol" : "smart_money",
      sourceKey: "gmgn:smart-money:" + wallet.address,
    payload: wallet,
  })));
  increment("gmgn_wallet_imports_total", { status: "imported" }, gmgnImport.imported.length);
  if (gmgnImport.rejected.length) increment("gmgn_wallet_imports_total", { status: "rejected" }, gmgnImport.rejected.length);
  return {
    provider: "gmgn",
    symbol,
    chain,
    marketType: "onchain",
    timestamp: timestamp < 100000000000 ? timestamp * 1000 : timestamp,
    price,
    volume,
    liquidity,
    securityRisk: securityRisk(security),
    sourceType: "rest",
    sourceConfidence: 0.78,
    status: "ok",
    metadata: {
      evidenceGroup: "ONCHAIN",
      providerClass: "GMGN_READ_ONLY",
      tokenAddress: address,
      features: ["TOKEN_INFO", "TOKEN_SECURITY", "TOKEN_POOL", "TOKEN_HOLDERS", "TOKEN_TRADERS", "SMART_MONEY"],
      contributingEndpoints: featureSources.map((name) => READ_ONLY_ENDPOINTS[name] || name),
      holderCount,
      smartMoneyHolderCount: smartHolders.length,
      smartMoneyTraderCount: smartTraders.length,
      smartMoneyActivityCount: smartMoneyFeed.length,
      smartMoneyWallets: walletRows,
      importedWalletCount: gmgnImport.imported.length,
      rejectedWalletCount: gmgnImport.rejected.length,
      tokenName: info.name || info.token_name || info.symbol || null,
      tokenSymbol: info.symbol || null,
      security: {
        honeypot: security.is_honeypot ?? null,
        rugRatio: security.rug_ratio ?? null,
        sellTax: security.sell_tax ?? null,
        top10HolderRate: security.top_10_holder_rate ?? null,
      },
      pool: {
        address: pool.address || pool.pool_address || null,
        dex: pool.dex_name || pool.dex || null,
        liquidity,
      },
      warnings,
      readOnly: true,
      tradingEndpointsExcluded: ["/v1/trade/swap", "/v1/trade/follow_wallet", "/v1/trade/strategy/create", "/v1/cooking/create_token"],
    },
  };
}

async function safeCall(name, fn, warnings) {
  try {
    return await fn();
  } catch (error) {
    warnings.push(name + ": " + error.message);
    return null;
  }
}

async function collectGmgnEvidence(context = {}) {
  const symbol = String(context.symbol || "").toUpperCase();
  if (!isEnabled(context)) return { provider: "gmgn", symbol, status: "unavailable", error: "GMGN provider is disabled.", metadata: { evidenceGroup: "ONCHAIN", readOnly: true } };
  if (!apiKey(context)) return { provider: "gmgn", symbol, status: "unavailable", error: "GMGN_API_KEY is not configured.", metadata: { evidenceGroup: "ONCHAIN", readOnly: true } };
  const chain = normalizedChain(context.gmgnChain || context.chain || context.network);
  const address = context.contractAddress || context.tokenAddress;
  if (!chain || !address) return { provider: "gmgn", symbol, status: "unavailable", error: "GMGN token evidence requires gmgnChain and contractAddress.", metadata: { evidenceGroup: "ONCHAIN", readOnly: true } };
  const warnings = [];
  const query = { chain, address };
  const responses = {};
  responses.info = await safeCall("token_info", () => cachedRequest("GET", READ_ONLY_ENDPOINTS.tokenInfo, query, null, context), warnings);
  responses.security = await safeCall("token_security", () => cachedRequest("GET", READ_ONLY_ENDPOINTS.tokenSecurity, query, null, context), warnings);
  responses.pool = await safeCall("token_pool", () => cachedRequest("GET", READ_ONLY_ENDPOINTS.tokenPool, query, null, context), warnings);
  responses.holders = await safeCall("token_holders", () => cachedRequest("GET", READ_ONLY_ENDPOINTS.tokenHolders, { ...query, limit: 20, tag: "smart_degen" }, null, context), warnings);
  responses.traders = await safeCall("token_traders", () => cachedRequest("GET", READ_ONLY_ENDPOINTS.tokenTraders, { ...query, limit: 20, tag: "smart_degen" }, null, context), warnings);
  responses.smartMoney = await safeCall("smart_money", () => cachedRequest("GET", READ_ONLY_ENDPOINTS.smartMoney, { chain, limit: 20 }, null, context), warnings);
  const available = Object.values(responses).some((value) => value !== null);
  if (!available) return { provider: "gmgn", symbol, status: "unavailable", error: warnings.join("; ") || "GMGN returned no data.", metadata: { evidenceGroup: "ONCHAIN", readOnly: true, warnings } };
  return availableRecord(symbol, chain, address, responses, warnings, context);
}

async function getGmgnTrending(chain, interval = "1h", options = {}) {
  return cachedRequest("GET", READ_ONLY_ENDPOINTS.marketTrending, { chain: normalizedChain(chain), interval, ...(options.params || {}) }, null, options);
}

async function getGmgnTrenches(chain, options = {}) {
  return cachedRequest("POST", READ_ONLY_ENDPOINTS.marketTrenches, { chain: normalizedChain(chain) }, {
    types: options.types || ["new_creation", "near_completion", "completed"],
    limit: Math.min(80, Number(options.limit || 20)),
    ...(options.filters || {}),
  }, options);
}

async function getGmgnWalletActivity(chain, walletAddress, options = {}) {
  return cachedRequest("GET", READ_ONLY_ENDPOINTS.walletActivity, { chain: normalizedChain(chain), wallet_address: walletAddress, limit: Math.min(100, Number(options.limit || 50)) }, null, options);
}

async function getGmgnWalletStats(chain, walletAddresses, period = "7d", options = {}) {
  const wallets = Array.isArray(walletAddresses) ? walletAddresses : [walletAddresses];
  return cachedRequest("GET", READ_ONLY_ENDPOINTS.walletStats, { chain: normalizedChain(chain), wallet_address: wallets, period }, null, options);
}

async function refreshGmgnSmartMoney(options = {}) {
  if (!isEnabled(options)) return { status: "disabled", imported: [], rejected: [], warnings: ["GMGN provider is disabled."] };
  if (!apiKey(options)) return { status: "unavailable", imported: [], rejected: [], warnings: ["GMGN_API_KEY is not configured."] };
  const chain = normalizedChain(options.chain || process.env.GMGN_DEFAULT_CHAIN || "sol");
  const limit = Math.min(1000, Math.max(1, Number(options.limit || process.env.GMGN_SMART_MONEY_LIMIT || 100)));
  const response = await cachedRequest("GET", READ_ONLY_ENDPOINTS.smartMoney, { chain, limit }, null, options);
  const rows = asList(response);
  const candidates = rows.map(compactWallet).filter((wallet) => wallet.address).filter((wallet) => {
    const tag = JSON.stringify(wallet.tag || "");
    const hasEvidence = [wallet.realizedPnl, wallet.winRate, wallet.profitableTradeRatio, wallet.tradeCount, wallet.earlyEntryFrequency].some((item) => item !== null && item !== undefined && item !== "");
    return /smart|profitable|ranked/i.test(tag) && hasEvidence;
  }).slice(0, limit);
  const result = importGmgnWallets(candidates.map((wallet) => ({
    ...wallet,
    chain,
    category: /kol|ct|influencer/i.test(String(wallet.tag || "")) ? "kol" : "smart_money",
    sourceKey: "gmgn:smart-money-refresh:" + chain + ":" + wallet.address,
    payload: wallet,
  })));
  return {
    status: "refreshed",
    chain,
    limit,
    discovered: rows.length,
    qualified: candidates.length,
    ...result,
  };
}

function getGmgnHealth() {
  return {
    provider: "gmgn",
    enabled: isEnabled(),
    configured: Boolean(apiKey()),
    host: host(),
    cacheEntries: cache.size,
    circuit: gmgnCircuitBreaker.snapshot(),
    readOnly: true,
  };
}

function clearGmgnCache() {
  cache.clear();
}

module.exports = {
  READ_ONLY_ENDPOINTS,
  clearGmgnCache,
  collectGmgnEvidence,
  getGmgnHealth,
  getGmgnTrenches,
  getGmgnTrending,
  getGmgnWalletActivity,
  getGmgnWalletStats,
  refreshGmgnSmartMoney,
  normalizedChain,
};
