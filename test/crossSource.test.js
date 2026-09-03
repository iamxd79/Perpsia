const test = require("node:test");
const assert = require("node:assert/strict");


const { buildCrossSourceSignals } = require("../services/providers/crossSource");


test("detects cross-exchange confirmation and DEX acceleration", () => {
  const result = buildCrossSourceSignals([
    {
      provider: "binance",
      symbol: "BTC",
      status: "ok",
      marketType: "perpetual",
      freshness: { status: "fresh" },
      price: 102,
      spotPrice: 100,
      perpPrice: 102,
      priceChange: 4,
      funding: 0.0001,
      openInterest: 100,
      orderbook: { imbalance: 0.25 },
      metadata: { openInterestChangePct: 5 },
    },
    {
      provider: "bybit",
      symbol: "BTC",
      status: "ok",
      marketType: "perpetual",
      freshness: { status: "fresh" },
      price: 101,
      spotPrice: 100,
      perpPrice: 101,
      priceChange: 3,
      funding: 0.0002,
      openInterest: 110,
      orderbook: { imbalance: 0.2 },
      metadata: { openInterestChangePct: 4 },
    },
    {
      provider: "dexscreener",
      symbol: "BTC",
      status: "ok",
      marketType: "spot",
      freshness: { status: "fresh" },
      price: 103,
      metadata: { pairAddress: "pair", volumeAcceleration: 2.2, pairCreatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 },
    },
  ]);
  assert.equal(result.sourceAgreement, "agreement");
  assert.ok(result.scoreAdjustment > 0);
  assert.ok(result.signals.some((signal) => signal.type === "PRICE_OI_CONFIRMATION"));
  assert.ok(result.signals.some((signal) => signal.type === "DEX_VOLUME_ACCELERATION"));
  assert.ok(result.signals.some((signal) => signal.type === "EARLY_TOKEN_MOMENTUM"));
});


test("reduces confidence for critical security risk", () => {
  const result = buildCrossSourceSignals([
    {
      provider: "goplus",
      symbol: "SCAM",
      status: "ok",
      marketType: "security",
      freshness: { status: "fresh" },
      securityRisk: 100,
    },
  ]);
  assert.ok(result.scoreAdjustment <= -30);
  assert.equal(result.signals[0].hardRisk, true);
});
