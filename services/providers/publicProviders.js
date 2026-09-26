"use strict";
































































const axios = require("axios");
const {
  collectProviders,
  getEvidenceSummary,
  getProviderDefinitions,
  getProviderHealth,
  registerProvider,
} = require("./registry");
const { listPublicStreams } = require("./streams");
const { normalizeEvidence } = require("./evidence");
const { getStreamManager } = require("./streamManager");
const { collectAlchemyEvidence } = require("./alchemy");
const { collectGmgnEvidence } = require("./gmgn");
const { buildWalletEvidence } = require("../walletIntelligence");
































































const BINANCE_FUTURES = "https://fapi.binance.com";
const BINANCE_SPOT = "https://api.binance.com";
const BYBIT = "https://api.bybit.com";
const OKX = "https://www.okx.com";
const HYPERLIQUID = "https://api.hyperliquid.xyz/info";
const DEXSCREENER = "https://api.dexscreener.com";
const GECKOTERMINAL = "https://api.geckoterminal.com/api/v2";
const ALTERNATIVE = "https://api.alternative.me";
const FRED = "https://api.stlouisfed.org";
const GOPLUS = "https://api.gopluslabs.io";
const HONEYPOT = "https://api.honeypot.is";
const GITHUB = "https://api.github.com";
const liquiditySnapshots = new Map();
const MAX_LIQUIDITY_SNAPSHOTS = 500;
































































function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
































































function normalizeAssetSymbol(raw) {
  const value = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^\$/, "")
    .replace(/[\/:_-](USDT|USDC|USD|PERP|SWAP)$/, "")
    .replace(/(USDT|USDC|USD|PERP|SWAP)$/, "");
  return value.replace(/[^A-Z0-9.]/g, "");
}
































































function asUsdtSymbol(raw) {
  return normalizeAssetSymbol(raw) + "USDT";
}
































































function asOkxSwap(raw) {
  return normalizeAssetSymbol(raw) + "-USDT-SWAP";
}
































































function asOkxSpot(raw) {
  return normalizeAssetSymbol(raw) + "-USDT";
}
































































function depthSummary(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const bidVolume = bids.reduce((sum, level) => sum + (number(level?.[0]) || 0) * (number(level?.[1]) || 0), 0);
  const askVolume = asks.reduce((sum, level) => sum + (number(level?.[0]) || 0) * (number(level?.[1]) || 0), 0);
  const total = bidVolume + askVolume;
  const bestBid = number(bids[0]?.[0]);
  const bestAsk = number(asks[0]?.[0]);
  return {
    bidVolume,
    askVolume,
    imbalance: total > 0 ? (bidVolume - askVolume) / total : null,
    spreadBps: bestBid && bestAsk ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10000 : null,
    depth: bids.length + asks.length,
  };
}
































































function bybitDepthSummary(book) {
  return depthSummary({
    bids: book?.b || [],
    asks: book?.a || [],
  });
}
































































function okxDepthSummary(book) {
  return depthSummary({
    bids: book?.bids || [],
    asks: book?.asks || [],
  });
}
































































function hyperliquidDepthSummary(book) {
  const levels = Array.isArray(book?.levels) ? book.levels : [];
  return depthSummary({
    bids: (levels[0] || []).map((level) => [level.px, level.sz]),
    asks: (levels[1] || []).map((level) => [level.px, level.sz]),
  });
}
































































function responseData(response) {
  return response?.data ?? response;
}
































































async function getJson(url, options = {}) {
  const response = await axios.get(url, {
    timeout: options.timeoutMs || 8000,
    headers: options.headers,
    params: options.params,
  });
  return responseData(response);
}
































































async function postJson(url, body, options = {}) {
  const response = await axios.post(url, body, {
    timeout: options.timeoutMs || 8000,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return responseData(response);
}
































































function settledValue(result) {
  return result?.status === "fulfilled" ? result.value : null;
}
































































function evidenceStatus(price, availableCount) {
  if (availableCount === 0) {
    const error = new Error("provider returned no usable response");
    error.code = "NO_USABLE_RESPONSE";
    throw error;
  }
  return price === null ? "degraded" : "ok";
}
































































const BINANCE_DISCOVERY_TTL_MS = 60 * 1000;
let binanceDiscoveryCache = { expiresAt: 0, symbols: [] };
let bybitDiscoveryCache = { expiresAt: 0, symbols: [] };
const DISCOVERY_TTL_MS = 60 * 1000;
let okxDiscoveryCache = { expiresAt: 0, symbols: [] };
let hyperliquidDiscoveryCache = { expiresAt: 0, symbols: [] };

async function discoverBinancePerpetualSymbols(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit || 54)));
  const now = Date.now();
  if (binanceDiscoveryCache.expiresAt > now && binanceDiscoveryCache.symbols.length) {
    return binanceDiscoveryCache.symbols.slice(0, limit);
  }

  const rows = await getJson(BINANCE_FUTURES + "/fapi/v1/ticker/24hr", options);
  const excludedBases = new Set(["USDC", "USDT", "BUSD", "FDUSD", "DAI", "TUSD"]);
  const ranked = (Array.isArray(rows) ? rows : [])
    .filter((item) => String(item?.symbol || "").endsWith("USDT"))
    .map((item) => ({
      symbol: String(item.symbol).slice(0, -4),
      quoteVolume: Number(item.quoteVolume) || 0,
      priceChange: Number(item.priceChangePercent) || 0,
      trades: Number(item.count) || 0,
    }))
    .filter((item) => item.symbol && !excludedBases.has(item.symbol))
    .sort((left, right) => {
      const leftScore = Math.log10(1 + left.quoteVolume) * 0.65 + Math.min(25, Math.abs(left.priceChange)) * 0.25 + Math.log10(1 + left.trades) * 0.1;
      const rightScore = Math.log10(1 + right.quoteVolume) * 0.65 + Math.min(25, Math.abs(right.priceChange)) * 0.25 + Math.log10(1 + right.trades) * 0.1;
      return rightScore - leftScore;
    })
    .map((item) => item.symbol);

  binanceDiscoveryCache = { expiresAt: now + BINANCE_DISCOVERY_TTL_MS, symbols: ranked };
  return ranked.slice(0, limit);
}

async function discoverBybitPerpetualSymbols(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit || 54)));
  const now = Date.now();
  if (bybitDiscoveryCache.expiresAt > now && bybitDiscoveryCache.symbols.length) {
    return bybitDiscoveryCache.symbols.slice(0, limit);
  }
  const payload = await getJson(BYBIT + "/v5/market/tickers", {
    ...options,
    params: { category: "linear" },
  });
  if (payload?.retCode !== undefined && Number(payload.retCode) !== 0) {
    throw new Error(payload.retMsg || "Bybit market discovery failed");
  }
  const excludedBases = new Set(["USDC", "USDT", "BUSD", "FDUSD", "DAI", "TUSD"]);
  const ranked = (Array.isArray(payload?.result?.list) ? payload.result.list : [])
    .filter((item) => String(item?.symbol || "").endsWith("USDT"))
    .map((item) => ({
      symbol: String(item.symbol).slice(0, -4),
      turnover: Number(item.turnover24h) || 0,
      priceChange: Number(item.price24hPcnt) * 100 || 0,
    }))
    .filter((item) => item.symbol && !excludedBases.has(item.symbol))
    .sort((left, right) => {
      const leftScore = Math.log10(1 + left.turnover) * 0.75 + Math.min(25, Math.abs(left.priceChange)) * 0.25;
      const rightScore = Math.log10(1 + right.turnover) * 0.75 + Math.min(25, Math.abs(right.priceChange)) * 0.25;
      return rightScore - leftScore;
    })
    .map((item) => item.symbol);
  bybitDiscoveryCache = { expiresAt: now + BINANCE_DISCOVERY_TTL_MS, symbols: ranked };
  return ranked.slice(0, limit);
}


async function discoverOkxPerpetualSymbols(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit || 54)));
  const now = Date.now();
  if (okxDiscoveryCache.expiresAt > now && okxDiscoveryCache.symbols.length) {
    return okxDiscoveryCache.symbols.slice(0, limit);
  }
  const payload = await getJson(OKX + "/api/v5/market/tickers", {
    ...options,
    params: { instType: "SWAP" },
  });
  if (payload?.code !== undefined && String(payload.code) !== "0") {
    throw new Error(payload.msg || "OKX market discovery failed");
  }
  const ranked = (Array.isArray(payload?.data) ? payload.data : [])
    .filter((item) => String(item?.instId || "").endsWith("-USDT-SWAP"))
    .map((item) => ({
      symbol: String(item.instId).replace(/-USDT-SWAP$/, ""),
      volume: Number(item.volCcy24h) || Number(item.vol24h) || 0,
      priceChange: Number(item.open24h) && Number(item.last)
        ? ((Number(item.last) - Number(item.open24h)) / Number(item.open24h)) * 100
        : 0,
    }))
    .filter((item) => item.symbol)
    .sort((left, right) => {
      const leftScore = Math.log10(1 + left.volume) * 0.75 + Math.min(25, Math.abs(left.priceChange)) * 0.25;
      const rightScore = Math.log10(1 + right.volume) * 0.75 + Math.min(25, Math.abs(right.priceChange)) * 0.25;
      return rightScore - leftScore;
    })
    .map((item) => item.symbol);
  okxDiscoveryCache = { expiresAt: DISCOVERY_TTL_MS + now, symbols: ranked };
  return ranked.slice(0, limit);
}

async function discoverHyperliquidPerpetualSymbols(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit || 54)));
  const now = Date.now();
  if (hyperliquidDiscoveryCache.expiresAt > now && hyperliquidDiscoveryCache.symbols.length) {
    return hyperliquidDiscoveryCache.symbols.slice(0, limit);
  }
  const payload = await postJson(HYPERLIQUID, { type: "metaAndAssetCtxs" }, options);
  const universe = Array.isArray(payload?.[0]?.universe) ? payload[0].universe : [];
  const contexts = Array.isArray(payload?.[1]) ? payload[1] : [];
  const ranked = universe
    .map((item, index) => ({
      symbol: String(item?.name || ""),
      volume: Number(contexts[index]?.dayNtlVlm) || 0,
      priceChange: 0,
    }))
    .filter((item) => item.symbol && !item.symbol.includes(":"))
    .sort((left, right) => right.volume - left.volume)
    .map((item) => item.symbol);
  if (!ranked.length) throw new Error("Hyperliquid returned no perpetual markets");
  hyperliquidDiscoveryCache = { expiresAt: DISCOVERY_TTL_MS + now, symbols: ranked };
  return ranked.slice(0, limit);
}

async function fetchBinance(symbol, options = {}) {
  const asset = normalizeAssetSymbol(symbol);
  const pair = asUsdtSymbol(asset);
  const responses = await Promise.allSettled([
    getJson(BINANCE_FUTURES + "/fapi/v1/ticker/24hr?symbol=" + pair, options),
    getJson(BINANCE_FUTURES + "/fapi/v1/openInterest?symbol=" + pair, options),
    getJson(BINANCE_FUTURES + "/fapi/v1/premiumIndex?symbol=" + pair, options),
    getJson(BINANCE_FUTURES + "/fapi/v1/depth?symbol=" + pair + "&limit=20", options),
    getJson(BINANCE_SPOT + "/api/v3/ticker/24hr?symbol=" + pair, options),
  ]);
  const ticker = settledValue(responses[0]);
  const openInterest = settledValue(responses[1]);
  const premium = settledValue(responses[2]);
  const book = settledValue(responses[3]);
  const spotTicker = settledValue(responses[4]);
  const available = responses.filter((item) => item.status === "fulfilled").length;
  const price = number(ticker?.lastPrice);
  return {
    symbol: asset,
    marketType: "perpetual",
    timestamp: number(ticker?.closeTime) || Date.now(),
    price,
    volume: number(ticker?.quoteVolume) || number(ticker?.volume),
    openInterest: number(openInterest?.openInterest),
    funding: number(premium?.lastFundingRate),
    trades: number(ticker?.count),
    orderbook: depthSummary(book),
    priceChange: number(ticker?.priceChangePercent),
    spotPrice: number(spotTicker?.lastPrice),
    perpPrice: price,
    status: evidenceStatus(price, available),
    sourceConfidence: available >= 4 ? 0.9 : 0.7,
    metadata: {
      exchange: "Binance",
      pair,
      endpointCount: 5,
      availableEndpointCount: available,
      nextFundingTime: number(premium?.nextFundingTime),
    },
  };
}
































































async function fetchBybit(symbol, options = {}) {
  const asset = normalizeAssetSymbol(symbol);
  const pair = asUsdtSymbol(asset);
  const responses = await Promise.allSettled([
    getJson(BYBIT + "/v5/market/tickers", {
      ...options,
      params: { category: "linear", symbol: pair },
    }),
    getJson(BYBIT + "/v5/market/open-interest", {
      ...options,
      params: { category: "linear", symbol: pair, intervalTime: "4h", limit: 2 },
    }),
    getJson(BYBIT + "/v5/market/orderbook", {
      ...options,
      params: { category: "linear", symbol: pair, limit: 25 },
    }),
    getJson(BYBIT + "/v5/market/tickers", {
      ...options,
      params: { category: "spot", symbol: pair },
    }),
  ]);
  const ticker = settledValue(responses[0])?.result?.list?.[0];
  const oiList = settledValue(responses[1])?.result?.list || [];
  const book = settledValue(responses[2])?.result;
  const spotTicker = settledValue(responses[3])?.result?.list?.[0];
  const available = responses.filter((item) => item.status === "fulfilled").length;
  const price = number(ticker?.lastPrice);
  const currentOi = number(ticker?.openInterest) || number(oiList[0]?.openInterest);
  const previousOi = number(oiList[1]?.openInterest);
  return {
    symbol: asset,
    marketType: "perpetual",
    // The OI endpoint timestamp can lag by minutes; this is a composite REST snapshot.
    timestamp: Date.now(),
    price,
    volume: number(ticker?.turnover24h) || number(ticker?.volume24h),
    openInterest: currentOi,
    funding: number(ticker?.fundingRate),
    orderbook: bybitDepthSummary(book),
    priceChange: number(ticker?.price24hPcnt) === null ? null : number(ticker?.price24hPcnt) * 100,
    spotPrice: number(spotTicker?.lastPrice),
    perpPrice: price,
    status: evidenceStatus(price, available),
    sourceConfidence: available >= 3 ? 0.88 : 0.68,
    metadata: {
      exchange: "Bybit",
      pair,
      openInterestChangePct: currentOi !== null && previousOi ? ((currentOi - previousOi) / previousOi) * 100 : null,
      nextFundingTime: number(ticker?.nextFundingTime),
      availableEndpointCount: available,
    },
  };
}
































































async function fetchOkx(symbol, options = {}) {
  const asset = normalizeAssetSymbol(symbol);
  const swap = asOkxSwap(asset);
  const spot = asOkxSpot(asset);
  const responses = await Promise.allSettled([
    getJson(OKX + "/api/v5/market/ticker", {
      ...options,
      params: { instId: swap },
    }),
    getJson(OKX + "/api/v5/public/funding-rate", {
      ...options,
      params: { instId: swap },
    }),
    getJson(OKX + "/api/v5/public/open-interest", {
      ...options,
      params: { instType: "SWAP", instId: swap },
    }),
    getJson(OKX + "/api/v5/market/books", {
      ...options,
      params: { instId: swap, sz: "20" },
    }),
    getJson(OKX + "/api/v5/market/ticker", {
      ...options,
      params: { instId: spot },
    }),
  ]);
  const ticker = settledValue(responses[0])?.data?.[0];
  const funding = settledValue(responses[1])?.data?.[0];
  const openInterest = settledValue(responses[2])?.data?.[0];
  const book = settledValue(responses[3])?.data?.[0];
  const spotTicker = settledValue(responses[4])?.data?.[0];
  const available = responses.filter((item) => item.status === "fulfilled").length;
  const price = number(ticker?.last);
  const open = number(ticker?.open24h) || number(ticker?.sodUtc0);
  return {
    symbol: asset,
    marketType: "perpetual",
    timestamp: number(ticker?.ts) || Date.now(),
    price,
    volume: number(ticker?.volCcy24h) || number(ticker?.vol24h),
    openInterest: number(openInterest?.oi),
    funding: number(funding?.fundingRate),
    orderbook: okxDepthSummary(book),
    priceChange: price !== null && open ? ((price - open) / open) * 100 : null,
    spotPrice: number(spotTicker?.last),
    perpPrice: price,
    status: evidenceStatus(price, available),
    sourceConfidence: available >= 4 ? 0.86 : 0.66,
    metadata: {
      exchange: "OKX",
      swap,
      spot,
      nextFundingTime: number(funding?.fundingTime),
      availableEndpointCount: available,
    },
  };
}
































































async function fetchHyperliquid(symbol, options = {}) {
  const asset = normalizeAssetSymbol(symbol);
  const [metaResponse, bookResponse] = await Promise.all([
    postJson(HYPERLIQUID, { type: "metaAndAssetCtxs" }, options),
    postJson(HYPERLIQUID, { type: "l2Book", coin: asset }, options),
  ]);
  const meta = metaResponse?.[0] || {};
  const contexts = metaResponse?.[1] || [];
  const index = Array.isArray(meta.universe)
    ? meta.universe.findIndex((item) => String(item?.name || "").toUpperCase() === asset)
    : -1;
  if (index < 0 || !contexts[index]) throw new Error("asset is not listed on Hyperliquid");
  const context = contexts[index];
  const price = number(context.markPx) || number(context.oraclePx);
  const previous = number(context.prevDayPx);
  return {
    symbol: asset,
    marketType: "perpetual",
    timestamp: Date.now(),
    price,
    volume: number(context.dayNtlVlm),
    openInterest: number(context.openInterest),
    funding: number(context.funding),
    orderbook: hyperliquidDepthSummary(bookResponse),
    priceChange: price !== null && previous ? ((price - previous) / previous) * 100 : null,
    perpPrice: price,
    status: price === null ? "degraded" : "ok",
    sourceConfidence: 0.82,
    metadata: {
      exchange: "Hyperliquid",
      coin: asset,
      oraclePrice: number(context.oraclePx),
      previousDayPrice: previous,
      universeIndex: index,
    },
  };
}
































































function pairScore(pair, asset) {
  const base = String(pair?.baseToken?.symbol || "").toUpperCase();
  const quote = String(pair?.quoteToken?.symbol || "").toUpperCase();
  const exact = base === asset ? 1000000000 : quote === asset ? 500000000 : 0;
  return exact + (number(pair?.liquidity?.usd) || 0) + (number(pair?.volume?.h24) || 0);
}
































































function dexPairEvidence(pair, provider, asset) {
  const base = String(pair?.baseToken?.symbol || "").toUpperCase();
  const volume24h = number(pair?.volume?.h24);
  const volume1h = number(pair?.volume?.h1);
  const liquidity = number(pair?.liquidity?.usd);
  const buys = number(pair?.txns?.h24?.buys) || 0;
  const sells = number(pair?.txns?.h24?.sells) || 0;
  return {
    symbol: asset,
    marketType: "spot",
    chain: pair?.chainId || null,
    timestamp: Date.now(),
    price: number(pair?.priceUsd),
    spotPrice: number(pair?.priceUsd),
    volume: volume24h,
    liquidity,
    trades: buys + sells,
    priceChange: number(pair?.priceChange?.h24),
    status: number(pair?.priceUsd) === null ? "degraded" : "ok",
    sourceConfidence: provider === "dexscreener" ? 0.72 : 0.64,
    metadata: {
      exchange: pair?.dexId || null,
      pairAddress: pair?.pairAddress || null,
      baseToken: base,
      quoteToken: pair?.quoteToken?.symbol || null,
      pairCreatedAt: number(pair?.pairCreatedAt),
      buys24h: buys,
      sells24h: sells,
      volume1h,
      volume6h: number(pair?.volume?.h6),
      volumeAcceleration: volume1h !== null && volume24h > 0 ? volume1h / (volume24h / 24) : null,
      url: pair?.url || null,
    },
  };
}
































































async function fetchDexScreener(symbol, options = {}) {
  const asset = normalizeAssetSymbol(symbol);
  const body = await getJson(DEXSCREENER + "/latest/dex/search", {
    ...options,
    params: { q: asset },
  });
  const pairs = (Array.isArray(body?.pairs) ? body.pairs : [])
    .filter((pair) => {
      const base = String(pair?.baseToken?.symbol || "").toUpperCase();
      const quote = String(pair?.quoteToken?.symbol || "").toUpperCase();
      return base === asset || quote === asset;
    })
    .sort((a, b) => pairScore(b, asset) - pairScore(a, asset))
    .slice(0, 5);
  if (!pairs.length) throw new Error("no matching DEX pairs found");
  return pairs.map((pair) => dexPairEvidence(pair, "dexscreener", asset));
}
































































async function fetchGeckoTerminal(symbol, options = {}) {
  const asset = normalizeAssetSymbol(symbol);
  const body = await getJson(GECKOTERMINAL + "/search/pools", {
    ...options,
    headers: { Accept: "application/json;version=20230203" },
    params: { query: asset, page: 1 },
  });
  const pools = (Array.isArray(body?.data) ? body.data : [])
    .sort((a, b) => (number(b?.attributes?.reserve_in_usd) || 0) - (number(a?.attributes?.reserve_in_usd) || 0))
    .slice(0, 5);
  if (!pools.length) throw new Error("no matching GeckoTerminal pools found");
  return pools.map((pool) => {
    const attributes = pool.attributes || {};
    const volume = attributes.volume_usd || {};
    const transactions = attributes.transactions || {};
    const buys = number(transactions.h24?.buys) || 0;
    const sells = number(transactions.h24?.sells) || 0;
    return {
      symbol: asset,
      marketType: "spot",
      chain: pool.relationships?.network?.data?.id || null,
      timestamp: Date.now(),
      price: number(attributes.base_token_price_usd),
      spotPrice: number(attributes.base_token_price_usd),
      volume: number(volume.h24),
      liquidity: number(attributes.reserve_in_usd),
      trades: buys + sells,
      priceChange: number(attributes.price_change_percentage?.h24),
      status: number(attributes.base_token_price_usd) === null ? "degraded" : "ok",
      sourceConfidence: 0.62,
      metadata: {
        exchange: pool.relationships?.dex?.data?.id || null,
        poolAddress: attributes.address || pool.id || null,
        poolName: attributes.name || null,
        buys24h: buys,
        sells24h: sells,
        volume1h: number(volume.h1),
        volume6h: number(volume.h6),
        volumeAcceleration: number(volume.h1) !== null && number(volume.h24) > 0
          ? number(volume.h1) / (number(volume.h24) / 24)
          : null,
      },
    };
  });
}
































































async function fetchAlternative(symbol, options = {}) {
  const body = await getJson(ALTERNATIVE + "/fng/?limit=2", options);
  const current = Array.isArray(body?.data) ? body.data[0] : null;
  const previous = Array.isArray(body?.data) ? body.data[1] : null;
  if (!current) throw new Error("Fear & Greed response contained no data");
  return {
    symbol: symbol || "MARKET",
    marketType: "macro",
    timestamp: (number(current.timestamp) || Math.floor(Date.now() / 1000)) * 1000,
    status: "ok",
    sourceConfidence: 0.78,
    metadata: {
      index: "Crypto Fear & Greed",
      fearGreedValue: number(current.value),
      classification: current.value_classification || null,
      previousValue: number(previous?.value),
      previousClassification: previous?.value_classification || null,
      attribution: "Alternative.me",
    },
  };
}
































































async function fetchFred(symbol, options = {}) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY is not configured");
  const seriesId = options.fredSeriesId || process.env.FRED_SERIES_ID || "DFF";
  const body = await getJson(FRED + "/fred/series/observations", {
    ...options,
    params: {
      series_id: seriesId,
      api_key: apiKey,
      file_type: "json",
      sort_order: "desc",
      limit: 2,
    },
  });
  const observation = body?.observations?.[0];
  if (!observation || observation.value === ".") throw new Error("FRED returned no usable observation");
  return {
    symbol: symbol || "MARKET",
    marketType: "macro",
    timestamp: Date.parse(observation.date + "T00:00:00Z") || Date.now(),
    status: "ok",
    sourceConfidence: 0.8,
    metadata: {
      seriesId,
      value: number(observation.value),
      previousValue: number(body?.observations?.[1]?.value),
      attribution: "Federal Reserve Bank of St. Louis FRED",
    },
  };
}
































































function resolveContract(options = {}) {
  return options.contractAddress || process.env.PERPSIA_TOKEN_CONTRACT || null;
}
































































async function fetchGoPlus(symbol, options = {}) {
  const address = resolveContract(options);
  const chainId = String(options.chainId || process.env.PERPSIA_TOKEN_CHAIN_ID || "1");
  if (!address) throw new Error("token contract address is not configured");
  const body = await getJson(GOPLUS + "/api/v1/token_security/" + chainId, {
    ...options,
    params: { contract_addresses: address },
  });
  const data = body?.result?.[address.toLowerCase()] || body?.result?.[address] || null;
  if (!data) throw new Error("GoPlus returned no token security result");
  const flags = [
    data.is_honeypot === "1",
    data.is_blacklisted === "1",
    data.cannot_sell_all === "1",
    data.is_mintable === "1",
    data.owner_change_balance === "1",
  ];
  return {
    symbol,
    chain: chainId,
    marketType: "security",
    timestamp: Date.now(),
    securityRisk: Math.min(100, flags.filter(Boolean).length * 25),
    status: "ok",
    sourceConfidence: 0.82,
    metadata: {
      contractAddress: address,
      isHoneypot: data.is_honeypot,
      isOpenSource: data.is_open_source,
      isProxy: data.is_proxy,
      buyTax: number(data.buy_tax),
      sellTax: number(data.sell_tax),
      flags,
    },
  };
}
































































async function fetchHoneypot(symbol, options = {}) {
  const address = resolveContract(options);
  if (!address) throw new Error("token contract address is not configured");
  const chainId = String(options.chainId || process.env.PERPSIA_TOKEN_CHAIN_ID || "1");
  const body = await getJson(HONEYPOT + "/v2/IsHoneypot", {
    ...options,
    params: { address, chainID: chainId },
  });
  const honeypot = body?.honeypotResult?.isHoneypot;
  const risk = honeypot === true ? 100 : body?.summary?.risk === "high" ? 80 : body?.summary?.risk === "medium" ? 50 : 10;
  return {
    symbol,
    chain: chainId,
    marketType: "security",
    timestamp: Date.now(),
    securityRisk: risk,
    status: "ok",
    sourceConfidence: 0.8,
    metadata: {
      contractAddress: address,
      isHoneypot: honeypot,
      risk: body?.summary?.risk || null,
      buyTax: number(body?.simulationResult?.buyTax),
      sellTax: number(body?.simulationResult?.sellTax),
      holders: number(body?.holderAnalysis?.holders),
    },
  };
}
































































function parseGithubRepository(value) {
  const match = String(value || "").match(/github[.]com[/:]([^/]+)[/]([^/#]+?)(?:[.]git)?$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}
































































async function fetchGithub(symbol, options = {}) {
  const repository = parseGithubRepository(options.repository || process.env.GITHUB_REPOSITORY);
  if (!repository) throw new Error("GITHUB_REPOSITORY is not configured");
  const slug = repository.owner + "/" + repository.repo;
  const [repo, commits] = await Promise.all([
    getJson(GITHUB + "/repos/" + slug, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "PerpsIA",
        ...(process.env.GITHUB_TOKEN ? { Authorization: "Bearer " + process.env.GITHUB_TOKEN } : {}),
      },
    }),
    getJson(GITHUB + "/repos/" + slug + "/commits", {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "PerpsIA",
        ...(process.env.GITHUB_TOKEN ? { Authorization: "Bearer " + process.env.GITHUB_TOKEN } : {}),
      },
      params: { per_page: 1 },
    }),
  ]);
  return {
    symbol: symbol || repository.repo,
    marketType: "project",
    timestamp: Date.now(),
    status: "ok",
    sourceConfidence: 0.74,
    metadata: {
      repository: slug,
      stars: number(repo?.stargazers_count),
      forks: number(repo?.forks_count),
      openIssues: number(repo?.open_issues_count),
      pushedAt: repo?.pushed_at || null,
      latestCommitAt: commits?.[0]?.commit?.author?.date || null,
      archived: Boolean(repo?.archived),
      language: repo?.language || null,
    },
  };
}
































































registerProvider({
  id: "binance",
  name: "Binance",
  category: "derivatives",
  authentication: "none",
  rateLimit: "public exchange limits; request weight applies",
  transport: "REST+WebSocket",
  cacheTtlMs: 15000,
  collect: (context = {}) => fetchBinance(context.symbol, context),
});
































































registerProvider({
  id: "bybit",
  name: "Bybit",
  category: "derivatives",
  authentication: "none",
  rateLimit: "public exchange limits",
  transport: "REST+WebSocket",
  cacheTtlMs: 15000,
  collect: (context = {}) => fetchBybit(context.symbol, context),
});
































































registerProvider({
  id: "okx",
  name: "OKX",
  category: "derivatives",
  authentication: "none",
  rateLimit: "public exchange limits; IP based",
  transport: "REST+WebSocket",
  cacheTtlMs: 15000,
  collect: (context = {}) => fetchOkx(context.symbol, context),
});
































































registerProvider({
  id: "hyperliquid",
  name: "Hyperliquid",
  category: "derivatives",
  authentication: "none",
  rateLimit: "public info endpoint limits",
  transport: "REST+WebSocket",
  cacheTtlMs: 15000,
  collect: (context = {}) => fetchHyperliquid(context.symbol, context),
});

registerProvider({
  id: "alchemy",
  name: "Alchemy On-chain",
  category: "onchain",
  authentication: "ALCHEMY_API_KEY",
  rateLimit: "Alchemy plan limits; degraded evidence when unavailable",
  transport: "REST+Webhook",
  cacheTtlMs: 120000,
  sourceConfidence: 0.86,
  collect: collectAlchemyEvidence,
});

registerProvider({
  id: "gmgn",
  name: "GMGN Read-only Intelligence",
  category: "onchain-smart-money",
  authentication: "GMGN_API_KEY",
  rateLimit: "GMGN OpenAPI account limits; 429 responses are health-tracked",
  transport: "REST",
  cacheTtlMs: 60000,
  sourceConfidence: 0.78,
  collect: collectGmgnEvidence,
});

registerProvider({
  id: "wallet_intelligence",
  name: "PerpsIA Wallet Intelligence",
  category: "onchain-wallet",
  authentication: "SQLite registry + Alchemy/GMGN attribution",
  rateLimit: "Local deterministic analysis",
  transport: "SQLite",
  cacheTtlMs: 15000,
  sourceConfidence: 0.82,
  collect: (context = {}) => buildWalletEvidence(context.symbol, context),
});
































































registerProvider({
  id: "dexscreener",
  name: "DexScreener",
  category: "dex-discovery",
  authentication: "none",
  rateLimit: "300 requests/min for pair/search endpoints",
  transport: "REST",
  cacheTtlMs: 60000,
  collect: (context = {}) => fetchDexScreener(context.symbol, context),
});
































































registerProvider({
  id: "geckoterminal",
  name: "GeckoTerminal",
  category: "dex-discovery",
  authentication: "none",
  rateLimit: "approximately 10 requests/min on public API",
  transport: "REST",
  cacheTtlMs: 60000,
  collect: (context = {}) => fetchGeckoTerminal(context.symbol, context),
});
































































registerProvider({
  id: "alternative",
  name: "Alternative.me Fear & Greed",
  category: "macro-sentiment",
  authentication: "none",
  rateLimit: "public API; no published hard limit",
  transport: "REST",
  cacheTtlMs: 300000,
  collect: (context = {}) => fetchAlternative(context.symbol, context),
});
































































registerProvider({
  id: "fred",
  name: "FRED",
  category: "macro",
  authentication: "FRED_API_KEY",
  rateLimit: "FRED account/API limits",
  transport: "REST",
  cacheTtlMs: 900000,
  collect: (context = {}) => fetchFred(context.symbol, context),
});
































































registerProvider({
  id: "goplus",
  name: "GoPlus Security",
  category: "security",
  authentication: "none",
  rateLimit: "public API limits",
  transport: "REST",
  cacheTtlMs: 900000,
  collect: (context = {}) => fetchGoPlus(context.symbol, context),
});
































































registerProvider({
  id: "honeypot",
  name: "Honeypot.is",
  category: "security",
  authentication: "none",
  rateLimit: "public API limits",
  transport: "REST",
  cacheTtlMs: 900000,
  collect: (context = {}) => fetchHoneypot(context.symbol, context),
});
































































registerProvider({
  id: "github",
  name: "GitHub public API",
  category: "project-activity",
  authentication: "optional GITHUB_TOKEN",
  rateLimit: "60 requests/hour unauthenticated; higher with token",
  transport: "REST",
  cacheTtlMs: 900000,
  collect: (context = {}) => fetchGithub(context.symbol, context),
});
































































function defaultProviderIds(options = {}) {
  if (Array.isArray(options.providers) && options.providers.length) {
    const providers = [...options.providers];
    if (process.env.ALCHEMY_ENABLED === "true" && !providers.includes("alchemy")) providers.push("alchemy");
    return providers;
  }
  if (process.env.PERPSIA_PROVIDER_LIST) {
    const providers = process.env.PERPSIA_PROVIDER_LIST.split(",").map((item) => item.trim()).filter(Boolean);
    if (process.env.ALCHEMY_ENABLED === "true" && !providers.includes("alchemy")) providers.push("alchemy");
    return providers;
  }
  const ids = ["binance", "bybit", "okx", "hyperliquid", "dexscreener", "alternative"];
  if (options.includeGecko || process.env.PERPSIA_ENABLE_GECKO === "true") ids.push("geckoterminal");
  if (options.includeOptional || process.env.PERPSIA_ENABLE_OPTIONAL_PROVIDERS === "true") {
    if (process.env.FRED_API_KEY) ids.push("fred");
    if (options.contractAddress || process.env.PERPSIA_TOKEN_CONTRACT) ids.push("goplus", "honeypot");
    if (options.repository || process.env.GITHUB_REPOSITORY) ids.push("github");
  }
  if (process.env.ALCHEMY_ENABLED === "true") ids.push("alchemy");
  return ids;
}
































































function getProviderCatalog() {
  const streams = new Map(listPublicStreams().map((item) => [item.provider, item]));
  return getProviderDefinitions().map((definition) => ({
    ...definition,
    stream: streams.get(definition.id) || null,
  }));
}




async function collectMarketEvidence(symbol, options = {}) {
  const context = {
    ...options,
    symbol: normalizeAssetSymbol(symbol),
    cacheKey: options.cacheKey || normalizeAssetSymbol(symbol),
  };
  const providerIds = defaultProviderIds(options);
  if (process.env.PERPSIA_ENABLE_WEBSOCKETS !== "false") {
    const streamProviders = options.venue
      ? providerIds.filter((provider) => String(provider).toLowerCase() === String(options.venue).toLowerCase())
      : providerIds;
    getStreamManager().ensureSubscriptions(streamProviders, context.symbol);
  }
  const records = await collectProviders(providerIds, context);
  const cmcEvidence = options.cmcEvidence
    ? normalizeEvidence({
        provider: "coinmarketcap",
        symbol: context.symbol,
        sourceConfidence: 0.92,
        status: "ok",
        ...options.cmcEvidence,
        metadata: {
          integration: "CoinMarketCap Skill Hub",
          ...(options.cmcEvidence.metadata || {}),
        },
      })
    : null;
  const enrichedRecords = records.map((record) => {
    const pairAddress = record.metadata?.pairAddress || record.metadata?.poolAddress;
    if (record.liquidity === null || !pairAddress) return record;
    const snapshotKey = record.provider + ":" + pairAddress;
    const previous = liquiditySnapshots.get(snapshotKey);
    const metadata = { ...record.metadata };
    if (previous !== undefined && previous > 0) {
      metadata.liquidityChangePct = ((record.liquidity - previous) / previous) * 100;
    }
    while (liquiditySnapshots.size >= MAX_LIQUIDITY_SNAPSHOTS) {
      liquiditySnapshots.delete(liquiditySnapshots.keys().next().value);
    }
    liquiditySnapshots.set(snapshotKey, record.liquidity);
    return { ...record, metadata };
  });
  const allRecords = cmcEvidence ? [cmcEvidence, ...enrichedRecords] : enrichedRecords;
  return {
    records: allRecords,
    summary: getEvidenceSummary(allRecords),
    sources: allRecords.map((record) => ({
      provider: record.provider,
      status: record.status,
      sourceType: record.sourceType || record.metadata?.sourceType || "rest",
      timestamp: record.timestamp,
      ageMs: record.freshness?.ageMs ?? null,
      stale: record.freshness?.status === "stale",
      usable: record.usable !== false && record.freshness?.usable !== false,
      fields: Object.keys(record).filter((key) => !["provider", "symbol", "metadata", "error"].includes(key) && record[key] !== null),
      attribution: record.metadata?.attribution || record.metadata?.exchange || record.provider,
    })),
  };
}
































































module.exports = {
  collectMarketEvidence,
  discoverBinancePerpetualSymbols,
  discoverBybitPerpetualSymbols,
  discoverOkxPerpetualSymbols,
  discoverHyperliquidPerpetualSymbols,
  fetchAlternative,
  fetchBinance,
  fetchBybit,
  fetchDexScreener,
  fetchFred,
  fetchGeckoTerminal,
  fetchGithub,
  fetchGoPlus,
  fetchHoneypot,
  fetchHyperliquid,
  fetchOkx,
  getProviderCatalog,
  getProviderDefinitions,
  getProviderHealth,
  listPublicStreams,
  normalizeAssetSymbol,
};
