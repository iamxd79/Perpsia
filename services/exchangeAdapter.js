// ==========================================
// PERPSIA EXCHANGE ADAPTER
// ==========================================
// Canonical venue registry used by scanner commands and CMC Skill Hub calls.
// Exchange lists are metadata only: CMC skill schemas must receive "venue",
// not exchange_list/spot_exchange_list/orderbook_exchange fields.

const DEFAULT_VENUE = "Binance";

const exchangeConfigs = {
  Binance: {
    name: "Binance",
    aliases: ["binance"],
    spot_exchanges: ["Binance"],
    perp_exchanges: ["Binance"],
    orderbook_exchange: "Binance",
  },
  Bybit: {
    name: "Bybit",
    aliases: ["bybit"],
    spot_exchanges: ["Bybit"],
    perp_exchanges: ["Bybit"],
    orderbook_exchange: "Bybit",
  },
  OKX: {
    name: "OKX",
    aliases: ["okx", "okex"],
    spot_exchanges: ["OKX"],
    perp_exchanges: ["OKX"],
    orderbook_exchange: "OKX",
  },
  Dydx: {
    name: "Dydx",
    aliases: ["dydx", "dydxv4"],
    spot_exchanges: ["Coinbase"],
    perp_exchanges: ["Dydx"],
    orderbook_exchange: "Dydx",
  },
  Hyperliquid: {
    name: "Hyperliquid",
    aliases: ["hyperliquid", "hl"],
    spot_exchanges: ["Binance", "Coinbase"],
    perp_exchanges: ["Hyperliquid"],
    orderbook_exchange: "Hyperliquid",
  },
};

function normalizeVenueKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\\s_-]+/g, "");
}

const venueAliases = new Map();

for (const [key, config] of Object.entries(exchangeConfigs)) {
  for (const alias of [key, config.name, ...(config.aliases || [])]) {
    venueAliases.set(normalizeVenueKey(alias), key);
  }
}

/**
 * Resolve a user-provided venue to one canonical exchange name.
 */
function normalizeVenue(venue = DEFAULT_VENUE) {
  const requested = String(venue ?? DEFAULT_VENUE).trim() || DEFAULT_VENUE;
  const canonical = venueAliases.get(normalizeVenueKey(requested));

  if (!canonical) {
    throw new Error(
      "Unknown venue: " + requested + ". Supported: " + Object.keys(exchangeConfigs).join(", ")
    );
  }

  return canonical;
}

/**
 * Validate exchange and return its canonical config.
 */
function getExchangeConfig(venue = DEFAULT_VENUE) {
  return exchangeConfigs[normalizeVenue(venue)];
}

/**
 * Build schema-safe CMC Skill Hub parameters.
 *
 * Do not forward exchange_list, spot_exchange_list, orderbook_exchange, or
 * other exchange-routing fields: the relevant CMC skills reject them as
 * additional properties. The supported venue is represented by "venue".
 */
function buildCMCParams(symbol, venue = DEFAULT_VENUE, params = {}) {
  const config = getExchangeConfig(venue);
  const safeParams = {
    ...(params && typeof params === "object" && !Array.isArray(params) ? params : {}),
  };

  for (const forbiddenKey of [
    "exchange_list",
    "spot_exchange_list",
    "orderbook_exchange",
    "spotExchanges",
    "perpExchanges",
    "orderbookExchange",
  ]) {
    delete safeParams[forbiddenKey];
  }

  return {
    ...safeParams,
    symbol: String(symbol).trim().replace(/^\\$/, "").toUpperCase(),
    venue: config.name,
  };
}

function listSupportedExchanges() {
  return Object.keys(exchangeConfigs).map((key) => {
    const config = exchangeConfigs[key];

    return {
      name: config.name,
      perp: [...config.perp_exchanges],
      spot: [...config.spot_exchanges],
    };
  });
}

function isExchangeSupported(venue) {
  try {
    normalizeVenue(venue);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_VENUE,
  exchangeConfigs,
  normalizeVenue,
  getExchangeConfig,
  buildCMCParams,
  listSupportedExchanges,
  isExchangeSupported,
};
