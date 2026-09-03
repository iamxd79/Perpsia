// ==========================================
// PERPSIA EXCHANGE ADAPTER
// ==========================================
// Supports Binance, Bybit, OKX with standardized interface

const exchangeConfigs = {
  Binance: {
    name: "Binance",
    symbol: "Binance",
    spotExchanges: ["Binance"],
    perpExchanges: ["Binance"],
    orderbookExchange: "Binance",
  },
  Bybit: {
    name: "Bybit",
    symbol: "Bybit",
    spotExchanges: ["Bybit"],
    perpExchanges: ["Bybit"],
    orderbookExchange: "Bybit",
  },
  OKX: {
    name: "OKX",
    symbol: "OKX",
    spotExchanges: ["OKX"],
    perpExchanges: ["OKX"],
    orderbookExchange: "OKX",
  },
  Dydx: {
    name: "Dydx",
    symbol: "Dydx",
    spotExchanges: ["Coinbase"],
    perpExchanges: ["Dydx"],
    orderbookExchange: "Dydx",
  },
  Hyperliquid: {
    name: "Hyperliquid",
    symbol: "Hyperliquid",
    spotExchanges: ["Binance", "Coinbase"],
    perpExchanges: ["Hyperliquid"],
    orderbookExchange: "Hyperliquid",
  },
};

/**
 * Validate exchange and return config
 */
function getExchangeConfig(venue) {
  const venue_normalized = String(venue || "Binance").trim();

  const config = exchangeConfigs[venue_normalized];

  if (!config) {
    throw new Error(
      `Unknown venue: ${venue_normalized}. Supported: ${Object.keys(exchangeConfigs).join(", ")}`
    );
  }

  return config;
}

/**
 * Build CMC Skill Hub parameters from exchange config
 */
function buildCMCParams(symbol, venue, params = {}) {
  const config = getExchangeConfig(venue);

  return {
    symbol: String(symbol).toUpperCase(),
    venue: config.name,
    exchange_list: config.perpExchanges.join(","),
    spot_exchange_list: config.spotExchanges.join(","),
    orderbook_exchange: config.orderbookExchange,
    ...params,
  };
}

/**
 * Get all supported exchanges
 */
function listSupportedExchanges() {
  return Object.keys(exchangeConfigs).map((key) => ({
    name: exchangeConfigs[key].name,
    perp: exchangeConfigs[key].perpExchanges,
    spot: exchangeConfigs[key].spotExchanges,
  }));
}

/**
 * Check if exchange is supported
 */
function isExchangeSupported(venue) {
  try {
    getExchangeConfig(venue);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getExchangeConfig,
  buildCMCParams,
  listSupportedExchanges,
  isExchangeSupported,
  exchangeConfigs,
};
