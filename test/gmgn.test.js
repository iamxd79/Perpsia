const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const {
  clearGmgnCache,
  collectGmgnEvidence,
} = require("../services/providers/gmgn");

test("GMGN is disabled without credentials and does not require a private key", async () => {
  const result = await collectGmgnEvidence({ symbol: "TEST", enabled: false });
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /disabled/i);
});

test("GMGN normalizes read-only token intelligence and never calls trading routes", async () => {
  const previousRequest = axios.request;
  clearGmgnCache();
  const paths = [];
  axios.request = async (config) => {
    paths.push(config.url);
    assert.equal(config.headers["X-APIKEY"], "test-gmgn-key");
    assert.ok(config.params.timestamp);
    assert.ok(config.params.client_id);
    if (config.url.endsWith("/v1/token/info")) return { status: 200, headers: {}, data: { code: 0, data: { symbol: "TEST", price: { price: "1.5", volume_24h: "250000" }, holder_count: 1200 } } };
    if (config.url.endsWith("/v1/token/security")) return { status: 200, headers: {}, data: { code: 0, data: { risk_score: 8, is_honeypot: false } } };
    if (config.url.endsWith("/v1/token/pool_info")) return { status: 200, headers: {}, data: { code: 0, data: { liquidity: 900000, pool_address: "pool-1" } } };
    if (config.url.endsWith("/v1/market/token_top_holders")) return { status: 200, headers: {}, data: { code: 0, data: [{ address: "wallet-1", tag: "smart_degen", buy_volume_cur: 1000 }] } };
    if (config.url.endsWith("/v1/market/token_top_traders")) return { status: 200, headers: {}, data: { code: 0, data: [{ address: "wallet-2", tag: "smart_money", pnl: 2 }] } };
    if (config.url.endsWith("/v1/user/smartmoney")) return { status: 200, headers: {}, data: { code: 0, data: [{ token_address: "token-1", address: "wallet-3", tag: "smart_money" }] } };
    throw new Error("Unexpected endpoint");
  };
  try {
    const result = await collectGmgnEvidence({
      symbol: "TEST",
      enabled: true,
      apiKey: "test-gmgn-key",
      gmgnChain: "sol",
      contractAddress: "token-1",
      timeoutMs: 1000,
      persistWallets: false,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.provider, "gmgn");
    assert.equal(result.metadata.evidenceGroup, "ONCHAIN");
    assert.equal(result.metadata.readOnly, true);
    assert.equal(result.metadata.smartMoneyActivityCount, 1);
    assert.equal(result.securityRisk, 8);
    assert.ok(paths.every((path) => !/\/(trade|cooking|strategy)\/|\/swap(?:\/|$)/i.test(path)));
  } finally {
    axios.request = previousRequest;
    clearGmgnCache();
  }
});
