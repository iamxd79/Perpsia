const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const axios = require("axios");

const registry = require("../services/walletRegistry");
const { syncAlchemyWatchlist } = require("../services/alchemySync");

test("Alchemy Notify stays idle when no wallets or managed webhooks exist", async () => {
  const previous = {
    enabled: process.env.ALCHEMY_ENABLED,
    token: process.env.ALCHEMY_NOTIFY_AUTH_TOKEN,
    url: process.env.ALCHEMY_WEBHOOK_URL,
  };
  const previousRequest = axios.request;
  let calls = 0;
  process.env.ALCHEMY_ENABLED = "true";
  process.env.ALCHEMY_NOTIFY_AUTH_TOKEN = "test-notify-token";
  process.env.ALCHEMY_WEBHOOK_URL = "https://perpsia.example/webhooks/alchemy";
  registry.initializeWalletRegistry(new Database(":memory:"));
  axios.request = async () => {
    calls += 1;
    throw new Error("Alchemy Notify must not be called for an empty watchlist");
  };
  try {
    const result = await syncAlchemyWatchlist({ enabled: true });
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.match(result.reason, /no eligible wallets/i);
    assert.equal(result.selection.selectedWalletCount, 0);
    assert.equal(calls, 0);
  } finally {
    axios.request = previousRequest;
    if (previous.enabled === undefined) delete process.env.ALCHEMY_ENABLED;
    else process.env.ALCHEMY_ENABLED = previous.enabled;
    if (previous.token === undefined) delete process.env.ALCHEMY_NOTIFY_AUTH_TOKEN;
    else process.env.ALCHEMY_NOTIFY_AUTH_TOKEN = previous.token;
    if (previous.url === undefined) delete process.env.ALCHEMY_WEBHOOK_URL;
    else process.env.ALCHEMY_WEBHOOK_URL = previous.url;
  }
});
