const test = require("node:test");
const assert = require("node:assert/strict");

const {
  Backtester,
  normalizeSymbol,
} = require("../services/backtester");
const {
  withRetries,
  CircuitBreaker,
} = require("../services/resilience");

test("normalizes dollar-prefixed symbols for Binance futures", () => {
  assert.equal(normalizeSymbol("$BTC"), "BTCUSDT");
  assert.equal(normalizeSymbol("ETHUSDT"), "ETHUSDT");
});

test("returns TP2 when a candle reaches both targets", () => {
  const backtester = new Backtester();
  const outcome = backtester.findExitCandle(
    [
      { timestamp: 0, low: 99, high: 100, close: 100 },
      { timestamp: 1, low: 100, high: 120, close: 115 },
    ],
    0,
    "long",
    100,
    90,
    110,
    115
  );
  assert.equal(outcome.reason, "TP2_HIT");
  assert.equal(outcome.price, 115);
});

test("excludes open end-of-data trades from settled metrics", () => {
  const backtester = new Backtester();
  const stats = backtester.calculateMetrics([
    { pnlPercent: 5, status: "win" },
    { pnlPercent: -1, status: "loss" },
    { pnlPercent: 20, status: "open" },
  ]);
  assert.equal(stats.totalTrades, 2);
  assert.equal(stats.openTrades, 1);
  assert.equal(stats.winners, 1);
  assert.equal(stats.losers, 1);
  assert.equal(stats.winRate, 50);
});

test("retries transient failures with bounded attempts", async () => {
  let attempts = 0;
  const value = await withRetries(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary timeout");
      return "ok";
    },
    { retries: 2, baseDelayMs: 0, maxDelayMs: 0 }
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

test("circuit breaker opens after its failure threshold", async () => {
  const breaker = new CircuitBreaker(2, 60000);
  await assert.rejects(() => breaker.execute(async () => {
    throw new Error("provider timeout");
  }));
  await assert.rejects(() => breaker.execute(async () => {
    throw new Error("provider timeout");
  }));
  assert.equal(breaker.snapshot().state, "OPEN");
});
