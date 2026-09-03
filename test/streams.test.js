const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getStreamDefinition,
  listPublicStreams,
} = require("../services/providers/streams");

test("exposes public WebSocket definitions for all derivative providers", () => {
  const providers = listPublicStreams().map((item) => item.provider);
  assert.deepEqual(providers.sort(), ["binance", "bybit", "hyperliquid", "okx"]);
});

test("normalizes a Binance stream update into shared evidence", () => {
  const definition = getStreamDefinition("binance");
  const state = {};
  const evidence = definition.normalize({
    data: { e: "markPriceUpdate", p: "100", r: "0.0001", E: 1234 },
  }, state, "BTC");
  assert.equal(evidence.provider, "binance");
  assert.equal(evidence.price, 100);
  assert.equal(evidence.funding, 0.0001);
  assert.equal(evidence.metadata.transport, "WebSocket");
});
