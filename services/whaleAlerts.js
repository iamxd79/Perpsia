const axios = require("axios");

const DEFAULT_ENDPOINT =
  process.env.WHALE_ALERT_ENDPOINT ||
  "https://api.whale-alert.io/v1/transactions";
const DEFAULT_MIN_VALUE_USD = 1000000;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_LIMIT = 10;
const CACHE_TTL_MS = 10 * 60 * 1000;

const whaleCache = new Map();

const EXCHANGE_LABELS = [
  "binance",
  "bybit",
  "okx",
  "okex",
  "coinbase",
  "kraken",
  "kucoin",
  "gate.io",
  "gateio",
  "bitget",
  "bitfinex",
  "bitstamp",
  "gemini",
  "huobi",
  "mexc",
  "upbit",
  "poloniex",
  "deribit",
  "crypto.com",
];

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .replace(/^\$/, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = Number.parseFloat(
    String(value)
      .replace(/,/g, "")
      .replace(/[$%]/g, "")
      .replace(/−/g, "-")
      .trim()
  );

  return Number.isFinite(parsed) ? parsed : null;
}

function timestampToMs(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isExchangeLabel(value) {
  if (value === true) return true;
  if (!value) return false;

  const text = String(value).trim().toLowerCase();
  return (
    text === "exchange" ||
    text.includes("exchange") ||
    EXCHANGE_LABELS.some((label) => text.includes(label))
  );
}

function normalizeEndpoint(endpoint) {
  const record =
    endpoint && typeof endpoint === "object"
      ? endpoint
      : { address: endpoint, label: endpoint };

  const owner = record.owner;
  const ownerLabel =
    owner && typeof owner === "object"
      ? owner.label || owner.name || owner.type
      : owner;

  const label =
    record.label ||
    ownerLabel ||
    record.name ||
    record.type ||
    record.entity ||
    "unknown";

  return {
    address:
      record.address ||
      record.owner_address ||
      record.wallet_address ||
      record.hash ||
      null,
    label: String(label || "unknown"),
    isExchange:
      record.is_exchange === true ||
      record.isExchange === true ||
      isExchangeLabel(label) ||
      isExchangeLabel(record.type) ||
      isExchangeLabel(record.entity),
  };
}

function normalizeTransaction(transaction, symbol) {
  const timestampMs = timestampToMs(
    transaction.timestamp ||
      transaction.time ||
      transaction.datetime ||
      transaction.date
  );

  if (timestampMs === null) return null;

  const from = normalizeEndpoint(transaction.from || transaction.sender);
  const to = normalizeEndpoint(transaction.to || transaction.receiver);
  const amountUsd = toFiniteNumber(
    transaction.amount_usd ??
      transaction.amountUsd ??
      transaction.value_usd ??
      transaction.valueUsd ??
      transaction.usd_value ??
      transaction.estimated_value_usd
  );

  if (amountUsd === null) return null;

  return {
    hash:
      transaction.hash ||
      transaction.tx_hash ||
      transaction.transaction_hash ||
      null,
    timestamp: timestampMs,
    time: new Date(timestampMs).toISOString(),
    asset: normalizeSymbol(
      transaction.symbol ||
        transaction.currency ||
        transaction.asset ||
        symbol
    ),
    amount: toFiniteNumber(transaction.amount),
    valueUsd: amountUsd,
    from: from.address,
    fromLabel: from.label,
    fromIsExchange: from.isExchange,
    to: to.address,
    toLabel: to.label,
    toIsExchange: to.isExchange,
    transferType:
      from.isExchange && to.isExchange
        ? "EXCHANGE_TO_EXCHANGE"
        : to.isExchange
        ? "TO_EXCHANGE"
        : from.isExchange
        ? "FROM_EXCHANGE"
        : "WALLET_TO_WALLET",
    chain: transaction.blockchain || transaction.chain || null,
  };
}

function normalizeWhaleTransactions(transactions, symbol, options = {}) {
  const lookbackHours = Number(options.lookbackHours || DEFAULT_LOOKBACK_HOURS);
  const minValueUsd = Number(
    options.minValueUsd || DEFAULT_MIN_VALUE_USD
  );
  const cutoff = Date.now() - Math.max(1, lookbackHours) * 60 * 60 * 1000;

  return (Array.isArray(transactions) ? transactions : [])
    .map((transaction) => normalizeTransaction(transaction, symbol))
    .filter(
      (transaction) =>
        transaction &&
        transaction.timestamp >= cutoff &&
        transaction.valueUsd >= minValueUsd
    )
    .sort((a, b) => b.timestamp - a.timestamp);
}

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0";

  if (number >= 1000000000) return "$" + (number / 1000000000).toFixed(1) + "B";
  if (number >= 1000000) return "$" + (number / 1000000).toFixed(1) + "M";
  if (number >= 1000) return "$" + (number / 1000).toFixed(1) + "K";
  return "$" + number.toFixed(0);
}

function summarizeWhaleMoves(
  moves,
  symbol = "ASSET",
  lookbackHours = DEFAULT_LOOKBACK_HOURS
) {
  const recentMoves = Array.isArray(moves) ? moves : [];
  const volumeToExchanges = recentMoves
    .filter((move) => move.toIsExchange)
    .reduce((sum, move) => sum + move.valueUsd, 0);
  const volumeFromExchanges = recentMoves
    .filter((move) => move.fromIsExchange)
    .reduce((sum, move) => sum + move.valueUsd, 0);
  const windowLabel = String(lookbackHours) + "h";

  if (!recentMoves.length) {
    return (
      "No " +
      formatUsd(DEFAULT_MIN_VALUE_USD) +
      "+ whale transfers detected for $" +
      symbol +
      " in the last " +
      windowLabel +
      "."
    );
  }

  if (volumeToExchanges > volumeFromExchanges) {
    return (
      "🐋 " +
      formatUsd(volumeToExchanges) +
      " $" +
      symbol +
      " transferred to exchanges in the last " +
      windowLabel +
      " — potential sell-side pressure."
    );
  }

  if (volumeFromExchanges > volumeToExchanges) {
    return (
      "🐋 " +
      formatUsd(volumeFromExchanges) +
      " $" +
      symbol +
      " transferred from exchanges in the last " +
      windowLabel +
      " — potential accumulation."
    );
  }

  return (
    "🐋 " +
    formatUsd(volumeToExchanges + volumeFromExchanges) +
    " $" +
    symbol +
    " moved across exchange-linked wallets in the last " +
    windowLabel +
    " — transfer pressure is mixed."
  );
}

function buildActivity(symbol, moves, options = {}) {
  const volumeToExchanges = moves
    .filter((move) => move.toIsExchange)
    .reduce((sum, move) => sum + move.valueUsd, 0);
  const volumeFromExchanges = moves
    .filter((move) => move.fromIsExchange)
    .reduce((sum, move) => sum + move.valueUsd, 0);

  const largest = (list) =>
    list.length
      ? list.reduce((best, move) =>
          move.valueUsd > best.valueUsd ? move : best
        )
      : null;

  return {
    status: "available",
    symbol,
    lookbackHours: Number(options.lookbackHours || DEFAULT_LOOKBACK_HOURS),
    minValueUsd: Number(options.minValueUsd || DEFAULT_MIN_VALUE_USD),
    transactions: moves,
    recentMoves: moves,
    volumeToExchanges,
    volumeFromExchanges,
    largestMove: largest(moves),
    largestToExchange: largest(moves.filter((move) => move.toIsExchange)),
    largestFromExchange: largest(
      moves.filter((move) => move.fromIsExchange)
    ),
    summary: summarizeWhaleMoves(
      moves,
      symbol,
      Number(options.lookbackHours || DEFAULT_LOOKBACK_HOURS)
    ),
  };
}

function unavailable(symbol, reason) {
  const safeReason = String(reason || "Provider unavailable.").replace(
    /apikey=[^\&\s]+/gi,
    "apikey=[REDACTED]"
  );

  return {
    status: "unavailable",
    symbol,
    lookbackHours: DEFAULT_LOOKBACK_HOURS,
    minValueUsd: DEFAULT_MIN_VALUE_USD,
    transactions: [],
    recentMoves: [],
    volumeToExchanges: 0,
    volumeFromExchanges: 0,
    largestMove: null,
    largestToExchange: null,
    largestFromExchange: null,
    summary: "Whale Alert unavailable: " + safeReason,
    error: safeReason,
  };
}

function providerError(body) {
  if (!body || typeof body !== "object") {
    return "Whale Alert returned an invalid response.";
  }

  if (body.error) {
    return typeof body.error === "string"
      ? body.error
      : body.error.message || JSON.stringify(body.error);
  }

  if (body.result === "error" || body.status === "error" || body.success === false) {
    return body.message || "Whale Alert returned an error response.";
  }

  return null;
}

async function checkWhaleActivity(symbol, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const lookbackHours = Number(
    options.lookbackHours || DEFAULT_LOOKBACK_HOURS
  );
  const minValueUsd = Number(
    options.minValueUsd || DEFAULT_MIN_VALUE_USD
  );
  const limit = Math.max(
    1,
    Math.min(100, Number(options.limit || DEFAULT_LIMIT))
  );
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;

  if (!normalizedSymbol) {
    return unavailable("UNKNOWN", "No symbol was provided.");
  }

  if (!process.env.WHALE_ALERT_KEY) {
    return unavailable(normalizedSymbol, "WHALE_ALERT_KEY is not configured.");
  }

  const cacheKey = [
    normalizedSymbol,
    lookbackHours,
    minValueUsd,
    limit,
    endpoint,
  ].join(":");
  const cached = whaleCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  whaleCache.delete(cacheKey);

  try {
    const response = await axios.get(endpoint, {
      timeout: 15000,
      params: {
        apikey: process.env.WHALE_ALERT_KEY,
        min_value: minValueUsd,
        type: "transfer",
        currency: normalizedSymbol,
        limit,
      },
    });

    const body = response?.data;
    const error = providerError(body);

    if (error) {
      throw new Error(error);
    }

    if (!Array.isArray(body.transactions)) {
      throw new Error("Whale Alert response did not include transactions.");
    }

    const moves = normalizeWhaleTransactions(body.transactions, normalizedSymbol, {
      lookbackHours,
      minValueUsd,
    });
    const activity = buildActivity(normalizedSymbol, moves, {
      lookbackHours,
      minValueUsd,
    });

    whaleCache.set(cacheKey, {
      timestamp: Date.now(),
      data: activity,
    });

    return activity;
  } catch (error) {
    const message = String(error?.message || error || "Unknown provider error.");
    console.warn(
      "Whale Alert unavailable for $" + normalizedSymbol + ": " + message
    );
    return unavailable(normalizedSymbol, message);
  }
}

function clearWhaleCache() {
  whaleCache.clear();
}

module.exports = {
  checkWhaleActivity,
  normalizeWhaleTransactions,
  normalizeTransaction,
  summarizeWhaleMoves,
  formatUsd,
  clearWhaleCache,
};
