const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const axios = require("axios");

const {
  buildActivity,
  makeMove,
} = require("../services/whaleAlerts");
const {
  collectAlchemyActivity,
  clearAlchemyCache,
  parseAddressActivityPayload,
  recordAlchemyWebhook,
  verifyAlchemySignature,
} = require("../services/providers/alchemy");

test("Alchemy stays optional when disabled or not configured", async () => {
  const previousEnabled = process.env.ALCHEMY_ENABLED;
  const previousKey = process.env.ALCHEMY_API_KEY;
  delete process.env.ALCHEMY_ENABLED;
  delete process.env.ALCHEMY_API_KEY;
  const result = await collectAlchemyActivity("BTC");
  assert.equal(result.status, "unavailable");
  assert.match(result.error, /disabled/i);
  if (previousEnabled === undefined) delete process.env.ALCHEMY_ENABLED;
  else process.env.ALCHEMY_ENABLED = previousEnabled;
  if (previousKey === undefined) delete process.env.ALCHEMY_API_KEY;
  else process.env.ALCHEMY_API_KEY = previousKey;
});

test("Address Activity payloads normalize and webhook events are idempotent", () => {
  const payload = {
    id: "alchemy-test-webhook",
    network: "ETH_MAINNET",
    activity: [{
      hash: "0xalchemy-test-hash",
      fromAddress: "0x0000000000000000000000000000000000000001",
      toAddress: "0x0000000000000000000000000000000000000002",
      asset: "USDC",
      value: "1234.5",
      rawContract: {
        address: "0x0000000000000000000000000000000000000003",
        decimals: 6,
      },
      metadata: { blockTimestamp: new Date().toISOString() },
    }],
  };
  const events = parseAddressActivityPayload(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].chain, "ethereum");
  assert.equal(events[0].assetSymbol, "USDC");
  const first = recordAlchemyWebhook(payload);
  const second = recordAlchemyWebhook(payload);
  assert.equal(first.events, 1);
  assert.equal(second.duplicates, 1);
});

test("Alchemy signatures use the raw request body and normalized activity is ONCHAIN evidence", () => {
  const body = JSON.stringify({ id: "signature-test", activity: [] });
  const key = "test-signing-key";
  const signature = crypto.createHmac("sha256", key).update(body).digest("hex");
  assert.equal(verifyAlchemySignature(body, signature, key), true);
  assert.equal(verifyAlchemySignature(body + " ", signature, key), false);

  const now = Date.now();
  const moves = [
    makeMove({ hash: "0x1", timestamp: now, asset: "ETH", amount: 10, valueUsd: 25000, from: "0xwallet", to: "0xexchange", toIsExchange: true, chain: "ethereum", source: "ALCHEMY" }),
    makeMove({ hash: "0x2", timestamp: now - 1000, asset: "ETH", amount: 5, valueUsd: 12500, from: "0xexchange", fromIsExchange: true, to: "0xwallet2", chain: "ethereum", source: "ALCHEMY" }),
  ];
  const activity = buildActivity("ETH", moves, { provider: "ALCHEMY", lookbackHours: 24, limit: 10 }, [], 0, [{ chain: "ethereum", address: "0xcontract", symbol: "ETH" }]);
  assert.equal(activity.evidence.metadata.evidenceGroup, "ONCHAIN");
  assert.equal(activity.evidence.provider, "alchemy");
  assert.equal(activity.volumeToExchanges, 25000);
  assert.equal(activity.volumeFromExchanges, 12500);
});

test("Alchemy transfer polling is covered with mocked JSON-RPC and price responses", async () => {
  const previousEnabled = process.env.ALCHEMY_ENABLED;
  const previousKey = process.env.ALCHEMY_API_KEY;
  const previousNetworks = process.env.ALCHEMY_NETWORKS;
  const previousGet = axios.get;
  const previousPost = axios.post;
  process.env.ALCHEMY_ENABLED = "true";
  process.env.ALCHEMY_API_KEY = "test-key";
  process.env.ALCHEMY_NETWORKS = "ethereum";
  clearAlchemyCache();
  const methods = [];
  axios.get = async () => ({ data: { price: "2500" } });
  axios.post = async (_url, body) => {
    methods.push(body.method);
    if (body.method === "eth_blockNumber") return { data: { result: "0x100" } };
    if (body.method === "alchemy_getAssetTransfers") return {
      data: {
        result: {
          transfers: [{
            hash: "0xmock-alchemy-transfer",
            from: "0x0000000000000000000000000000000000000001",
            to: "0x0000000000000000000000000000000000000002",
            value: 4,
            rawContract: { rawValue: "0x3b9aca00", decimals: 8 },
            metadata: { blockTimestamp: new Date().toISOString() },
          }],
        },
      },
    };
    throw new Error("Unexpected mocked method: " + body.method);
  };
  try {
    const result = await collectAlchemyActivity("BTC", {
      enabled: true,
      apiKey: "test-key",
      networks: ["ethereum"],
      lookbackHours: 1,
      limit: 10,
      assets: [{ chain: "ethereum", address: "0x0000000000000000000000000000000000000003", symbol: "BTC", priceSymbol: "BTC", decimals: 8 }],
    });
    assert.equal(result.provider, "ALCHEMY");
    assert.equal(result.evidence.status, "ok");
    assert.equal(result.evidence.metadata.evidenceGroup, "ONCHAIN");
    assert.ok(methods.includes("eth_blockNumber"));
    assert.ok(methods.includes("alchemy_getAssetTransfers"));
  } finally {
    axios.get = previousGet;
    axios.post = previousPost;
    clearAlchemyCache();
    if (previousEnabled === undefined) delete process.env.ALCHEMY_ENABLED;
    else process.env.ALCHEMY_ENABLED = previousEnabled;
    if (previousKey === undefined) delete process.env.ALCHEMY_API_KEY;
    else process.env.ALCHEMY_API_KEY = previousKey;
    if (previousNetworks === undefined) delete process.env.ALCHEMY_NETWORKS;
    else process.env.ALCHEMY_NETWORKS = previousNetworks;
  }
});
