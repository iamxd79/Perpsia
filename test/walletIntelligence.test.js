const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const Database = require("better-sqlite3");

const registry = require("../services/walletRegistry");
const { analyzeWalletActivity, buildWalletEvidence } = require("../services/walletIntelligence");
const { syncAlchemyWatchlist } = require("../services/alchemySync");
const { evidenceDirection } = require("../services/signalQuality");

test("canonical wallet registry deduplicates wallets and rejects unverified exchange labels", () => {
  registry.initializeWalletRegistry(new Database(":memory:"));
  const first = registry.importManualWallet({
    address: "0x00000000000000000000000000000000000000a1",
    chain: "eth",
    label: "CT wallet",
    category: "kol",
    sourceUrl: "https://example.com/ct-wallet",
    approvalStatus: "approved",
  });
  const duplicate = registry.upsertWallet({
    address: first.wallet.address,
    chain: "ethereum",
    category: "kol",
    source: "manual",
    verificationStatus: "manual_approved",
  });
  assert.equal(first.wallet.id, duplicate.wallet.id);
  assert.equal(registry.listWallets({ enabled: true }).length, 1);

  const rejected = registry.importExchangeWallets([{
    address: "0x00000000000000000000000000000000000000e1",
    chain: "ethereum",
    exchange: "Binance",
    role: "deposit",
    category: "exchange_deposit",
    verificationStatus: "unverified",
    sourceUrl: "https://unknown.example/wallet",
  }]);
  assert.equal(rejected.imported.length, 0);
  assert.match(rejected.rejected[0].reason, /requires official/i);
});

test("GMGN import requires explicit classification and stores provenance", () => {
  const imported = registry.importGmgnWallets([
    {
      address: "0x00000000000000000000000000000000000000a2",
      chain: "ethereum",
      category: "smart_money",
      label: "GMGN Smart Money",
      sourceKey: "gmgn-smart-money-a2",
      pnl: 12345,
    },
    {
      address: "0x00000000000000000000000000000000000000a3",
      chain: "ethereum",
      label: "Unclassified",
    },
  ]);
  assert.equal(imported.imported.length, 1);
  assert.equal(imported.rejected.length, 1);
  assert.equal(imported.imported[0].verificationStatus, "provider_classified");
});

test("wallet intelligence calculates flows, convergence, acceleration, and LISTING_WATCH without direction", () => {
  const exchange = registry.importExchangeWallets([{
    address: "0x00000000000000000000000000000000000000e2",
    chain: "ethereum",
    exchange: "Binance",
    role: "deposit",
    verificationStatus: "official",
    source: "official_exchange",
    sourceUrl: "https://www.binance.com/en/proof-of-reserves",
  }]).imported[0];
  const team = registry.upsertWallet({
    address: "0x00000000000000000000000000000000000000a4",
    chain: "ethereum",
    category: "team",
    source: "manual",
    verificationStatus: "manual_approved",
  }).wallet;
  const smart = registry.listWallets({ category: "smart_money" });
  const now = Date.now();
  const events = [
    { eventKey: "event-smart-1", provider: "alchemy", chain: "ethereum", assetSymbol: "XYZ", valueUsd: 100, fromAddress: team.address, toAddress: smart[0].address, eventTime: now - 1000 },
    { eventKey: "event-smart-2", provider: "alchemy_webhook", chain: "ethereum", assetSymbol: "XYZ", valueUsd: 100, fromAddress: team.address, toAddress: smart[0].address, eventTime: now - 2000 },
    { eventKey: "event-exchange-1", txHash: "0xsame", provider: "alchemy", chain: "ethereum", assetSymbol: "XYZ", contractAddress: "0x00000000000000000000000000000000000000f1", valueUsd: 250, fromAddress: team.address, toAddress: exchange.address, eventTime: now - 3000 },
    { eventKey: "event-exchange-1-duplicate", provider: "alchemy_webhook", chain: "ethereum", assetSymbol: "XYZ", contractAddress: "0x00000000000000000000000000000000000000f1", txHash: "0xsame", valueUsd: 250, fromAddress: team.address, toAddress: exchange.address, eventTime: now - 3000 },
  ];
  const activity = analyzeWalletActivity("XYZ", { chain: "ethereum", events, now });
  assert.equal(activity.eventCount, 3);
  assert.equal(activity.windows["24h"].smartMoneyNetFlow, 200);
  assert.equal(activity.windows["24h"].exchangeInflow, 250);
  assert.ok(activity.windows["24h"].walletConvergence >= 1);
  assert.equal(activity.listingWatch[0].type, "LISTING_WATCH");
  const evidence = buildWalletEvidence("XYZ", { chain: "ethereum", events, now });
  assert.equal(evidence.metadata.evidenceGroup, "ONCHAIN");
  assert.equal(evidence.metadata.direction, undefined);
  assert.equal(evidenceDirection(evidence), null);
});

test("Alchemy watchlist sync updates only matching PerpsIA Address Activity webhooks", async () => {
  const previous = {
    enabled: process.env.ALCHEMY_ENABLED,
    token: process.env.ALCHEMY_NOTIFY_AUTH_TOKEN,
    url: process.env.ALCHEMY_WEBHOOK_URL,
  };
  process.env.ALCHEMY_ENABLED = "true";
  process.env.ALCHEMY_NOTIFY_AUTH_TOKEN = "test-notify-token";
  process.env.ALCHEMY_WEBHOOK_URL = "https://perpsia.example/webhooks/alchemy";
  registry.upsertWallet({
    address: "0x00000000000000000000000000000000000000a5",
    chain: "ethereum",
    category: "tracked_wallet",
    source: "manual",
    verificationStatus: "manual_approved",
  });
  const previousRequest = axios.request;
  const calls = [];
  axios.request = async (config) => {
    calls.push(config);
    if (config.url.endsWith("/team-webhooks")) return { status: 200, data: { data: [{ id: "perpsia-eth", network: "ETH_MAINNET", webhook_type: "ADDRESS_ACTIVITY", webhook_url: "https://perpsia.example/webhooks/alchemy", is_active: true }] } };
    if (config.url.endsWith("/webhook-addresses")) return { status: 200, data: { data: [] } };
    if (config.url.endsWith("/update-webhook-addresses")) return { status: 200, data: {} };
    throw new Error("Unexpected Alchemy management route: " + config.url);
  };
  try {
    const result = await syncAlchemyWatchlist({ enabled: true });
    assert.equal(result.status, "synced", JSON.stringify(result));
    assert.equal(result.syncedWalletCount, 5);
    assert.ok(calls.some((config) => config.url.endsWith("/update-webhook-addresses")));
    assert.equal(registry.listAlchemySync({ chain: "ethereum" }).some((row) => row.alchemySubscribed), true);
  } finally {
    axios.request = previousRequest;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name === "enabled" ? "ALCHEMY_ENABLED" : name === "token" ? "ALCHEMY_NOTIFY_AUTH_TOKEN" : "ALCHEMY_WEBHOOK_URL"];
      else process.env[name === "enabled" ? "ALCHEMY_ENABLED" : name === "token" ? "ALCHEMY_NOTIFY_AUTH_TOKEN" : "ALCHEMY_WEBHOOK_URL"] = value;
    }
  }
});
