const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildTradingLinksForSignal,
  getAvailableMarkets,
  isAllowedReferralUrl,
} = require("../services/tradingLinks");

function evidence(provider, metadata, price = 100) {
  return {
    provider,
    status: "ok",
    marketType: "perpetual",
    perpPrice: price,
    metadata,
  };
}

test("shows links only for exact markets verified by provider evidence", () => {
  const signal = {
    symbol: "BTC",
    isActionable: true,
    marketEvidence: [
      evidence("binance", { pair: "BTCUSDT" }),
      evidence("hyperliquid", { coin: "BTC" }),
      evidence("bybit", {}, 100),
      { ...evidence("okx", { swap: "BTC-USDT-SWAP" }), status: "unavailable" },
    ],
  };
  assert.deepEqual(getAvailableMarkets(signal).map(({ venue }) => venue), ["Binance", "Hyperliquid"]);
});

test("uses the configured Binance referral fallback without modifying a market URL", () => {
  const links = buildTradingLinksForSignal({
    symbol: "SOL",
    isActionable: true,
    marketEvidence: [evidence("binance", { pair: "SOLUSDT" }, 140)],
  }, {
    BINANCE_REF_CODE: "KPY12BIU",
    BINANCE_REF_URL: "https://www.binance.com/register?ref=KPY12BIU",
  });

  assert.equal(links.length, 1);
  assert.equal(links[0].url, "https://www.binance.com/register?ref=KPY12BIU");
  assert.equal(links[0].directUrl, "https://www.binance.com/en/futures/SOLUSDT");
  assert.equal(links[0].referralApplied, true);
});

test("uses normal direct links when optional referral configuration is empty", () => {
  const links = buildTradingLinksForSignal({
    symbol: "ETH",
    isActionable: true,
    marketEvidence: [
      evidence("hyperliquid", { coin: "ETH" }),
      evidence("bybit", { pair: "ETHUSDT" }),
      evidence("okx", { swap: "ETH-USDT-SWAP" }),
    ],
  }, {});

  assert.deepEqual(links.map(({ venue, url }) => [venue, url]), [
    ["Hyperliquid", "https://app.hyperliquid.xyz/trade/ETH"],
    ["Bybit", "https://www.bybit.com/trade/usdt/ETHUSDT"],
    ["OKX", "https://www.okx.com/trade-swap/eth-usdt-swap"],
  ]);
});

test("omits unsupported, mismatched, and non-actionable markets", () => {
  assert.deepEqual(buildTradingLinksForSignal({
    symbol: "SOL",
    isActionable: true,
    marketEvidence: [evidence("binance", { pair: "BTCUSDT" })],
  }, {}), []);
  assert.deepEqual(buildTradingLinksForSignal({
    symbol: "SOL",
    isActionable: false,
    marketEvidence: [evidence("binance", { pair: "SOLUSDT" })],
  }, {}), []);
});

test("rejects unsafe referral URLs", () => {
  assert.equal(isAllowedReferralUrl("http://binance.com/register", ["binance.com"]), false);
  assert.equal(isAllowedReferralUrl("https://binance.com.evil.example/register", ["binance.com"]), false);
  assert.equal(isAllowedReferralUrl("https://www.binance.com/register", ["binance.com"]), true);
});
