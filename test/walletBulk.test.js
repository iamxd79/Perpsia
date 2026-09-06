const assert = require("node:assert/strict");
const { test } = require("node:test");
const Database = require("better-sqlite3");

const registry = require("../services/walletRegistry");
const quality = require("../services/walletQuality");
const { targetWallets } = require("../services/alchemySync");

test("bulk GMGN import normalizes, scores, deduplicates, and rejects bad records", () => {
  registry.initializeWalletRegistry(new Database(":memory:"));
  const result = registry.importGmgnWallets([
    {
      address: "0x0000000000000000000000000000000000000b01",
      chain: "eth",
      category: "smart_money",
      label: "Ranked trader",
      realizedPnl: 25000,
      winRate: 0.82,
      profitableTradeRatio: 0.8,
      tradeCount: 120,
      earlyEntryFrequency: 0.7,
      sourceUrl: "https://gmgn.ai/",
    },
    {
      address: "0x0000000000000000000000000000000000000b01",
      chain: "ethereum",
      category: "smart_money",
      sourceUrl: "https://gmgn.ai/",
    },
    {
      address: "not-an-address",
      chain: "ethereum",
      category: "smart_money",
    },
  ]);
  assert.equal(result.created.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.imported[0].qualityScore > 0);
  assert.ok(["WATCH", "QUALITY", "HIGH_QUALITY", "ELITE"].includes(result.imported[0].qualityTier));
  assert.equal(result.imported[0].chain, "ethereum");
});

test("exchange and curated imports enforce provenance and keep pending records disabled", () => {
  registry.initializeWalletRegistry(new Database(":memory:"));
  const exchange = registry.importExchangeWallets([
    {
      address: "0x0000000000000000000000000000000000000b02",
      chain: "ethereum",
      exchange: "Upbit",
      role: "deposit",
      verificationStatus: "pending",
      sourceUrl: "https://example.com/upbit-proof",
    },
  ]);
  assert.equal(exchange.created.length, 1);
  assert.equal(exchange.imported[0].enabled, false);
  assert.equal(exchange.imported[0].monitoringPriority, 20);

  const kol = registry.importKols([{
    address: "0x0000000000000000000000000000000000000b03",
    chain: "base",
    label: "Public KOL",
    publicIdentityReference: "https://example.com/public-profile",
    verificationStatus: "manual_approved",
    approvalStatus: "approved",
    sourceUrl: "https://example.com/verification",
  }]);
  assert.equal(kol.created.length, 1);
  assert.equal(kol.imported[0].category, "kol");
  assert.equal(kol.imported[0].monitoringPriority, 60);
});

test("stronger provenance is preserved and quality thresholds are deterministic", () => {
  registry.initializeWalletRegistry(new Database(":memory:"));
  const first = registry.importManualWallet({
    address: "0x0000000000000000000000000000000000000b04",
    chain: "ethereum",
    category: "smart_money",
    label: "Manually approved wallet",
    verificationStatus: "manual_approved",
    approvalStatus: "approved",
    sourceUrl: "https://example.com/manual-proof",
  });
  const update = registry.importGmgnWallets([{
    address: first.wallet.address,
    chain: "ethereum",
    category: "smart_money",
    label: "GMGN relabel",
    sourceUrl: "https://gmgn.ai/",
  }]);
  assert.equal(update.imported[0].verificationStatus, "manual_approved");
  assert.equal(update.imported[0].label, "Manually approved wallet");
  const scored = quality.calculateWalletQuality({ realizedPnl: 10000, winRate: 0.8, tradeCount: 100, dataFreshness: 100 });
  assert.equal(scored.tier, "HIGH_QUALITY");
  assert.equal(quality.monitoringPriority({ category: "exchange_deposit", verificationStatus: "official", role: "deposit" }), 100);
});

test("Alchemy selection honors priority thresholds and address caps", () => {
  registry.initializeWalletRegistry(new Database(":memory:"));
  const previousMax = process.env.PERPSIA_MAX_ALCHEMY_WATCHED_ADDRESSES;
  const previousMin = process.env.PERPSIA_WALLET_MIN_SYNC_PRIORITY;
  process.env.PERPSIA_MAX_ALCHEMY_WATCHED_ADDRESSES = "1";
  process.env.PERPSIA_WALLET_MIN_SYNC_PRIORITY = "80";
  try {
    registry.importExchangeWallets([{
      address: "0x0000000000000000000000000000000000000b05",
      chain: "ethereum",
      exchange: "Binance",
      role: "deposit",
      verificationStatus: "official",
      sourceUrl: "https://example.com/binance-proof",
    }]);
    registry.importGmgnWallets([{
      address: "0x0000000000000000000000000000000000000b06",
      chain: "ethereum",
      category: "smart_money",
      tradeCount: 100,
      winRate: 0.9,
      realizedPnl: 50000,
      sourceUrl: "https://gmgn.ai/",
    }]);
    const selection = targetWallets();
    assert.equal(selection.selected.length, 1);
    assert.equal(selection.selected[0].monitoringPriority, 100);
    assert.equal(selection.eligible.length, 2);
  } finally {
    if (previousMax === undefined) delete process.env.PERPSIA_MAX_ALCHEMY_WATCHED_ADDRESSES;
    else process.env.PERPSIA_MAX_ALCHEMY_WATCHED_ADDRESSES = previousMax;
    if (previousMin === undefined) delete process.env.PERPSIA_WALLET_MIN_SYNC_PRIORITY;
    else process.env.PERPSIA_WALLET_MIN_SYNC_PRIORITY = previousMin;
  }
});
