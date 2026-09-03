const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeEvidence,
} = require("../services/providers/evidence");
const {
  collectProvider,
  getProviderHealth,
  registerProvider,
} = require("../services/providers/registry");

test("normalizes shared evidence without inventing missing fields", () => {
  const evidence = normalizeEvidence({
    provider: "fixture",
    symbol: "btc",
    timestamp: Date.now(),
    price: "100",
    orderbook: { bidVolume: "60", askVolume: "40" },
  });
  assert.equal(evidence.provider, "fixture");
  assert.equal(evidence.symbol, "BTC");
  assert.equal(evidence.price, 100);
  assert.equal(evidence.openInterest, null);
  assert.equal(evidence.orderbook.imbalance, 0.2);
  assert.equal(evidence.status, "ok");
});

test("provider failures are isolated and exposed as health state", async () => {
  registerProvider({
    id: "fixture-failure",
    retries: 0,
    collect: async () => {
      throw new Error("fixture unavailable");
    },
  });
  const result = await collectProvider("fixture-failure", {
    symbol: "BTC",
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "unavailable");
  assert.match(result[0].error, /fixture unavailable/);
  const health = getProviderHealth().find((item) => item.provider === "fixture-failure");
  assert.equal(health.status, "degraded");
  assert.equal(health.failures, 1);
});

test("successful evidence is cached between collection calls", async () => {
  let calls = 0;
  registerProvider({
    id: "fixture-cache",
    cacheTtlMs: 60000,
    collect: async ({ symbol }) => {
      calls += 1;
      return { symbol, price: 123, timestamp: Date.now() };
    },
  });
  const first = await collectProvider("fixture-cache", { symbol: "ETH" });
  const second = await collectProvider("fixture-cache", { symbol: "ETH" });
  assert.equal(first[0].price, 123);
  assert.equal(second[0].price, 123);
  assert.equal(calls, 1);
});
