const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getProviderDefinitions,
  normalizeAssetSymbol,
} = require("../services/providers/publicProviders");

test("registers the initial provider catalog without requiring credentials", () => {
  const ids = getProviderDefinitions().map((provider) => provider.id);
  for (const expected of [
    "binance",
    "bybit",
    "okx",
    "hyperliquid",
    "dexscreener",
    "geckoterminal",
    "goplus",
    "honeypot",
    "alternative",
    "fred",
    "github",
  ]) {
    assert.ok(ids.includes(expected), expected + " should be registered");
  }
});

test("normalizes common crypto symbol formats for public providers", () => {
  assert.equal(normalizeAssetSymbol("$SOLUSDT"), "SOL");
  assert.equal(normalizeAssetSymbol("BTC-USDT-SWAP"), "BTC");
  assert.equal(normalizeAssetSymbol("jup/usdt"), "JUP");
});
