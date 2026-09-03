const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  calculateSignalConfidence,
  groupEvidence,
  routeProviders,
} = require("../services/signalQuality");
const {
  evaluateSignalOutcomes,
  getSignalQualityReport,
  initializeSignalQuality,
  recordQualitySignal,
} = require("../services/signalQualityStore");

test("collapses multiple CEX venues into one derivatives evidence group", () => {
  const grouped = groupEvidence({
    direction: "Bullish",
    marketEvidence: [
      { provider: "binance", status: "ok", priceChange24h: 1 },
      { provider: "bybit", status: "ok", priceChange24h: 1.2 },
      { provider: "okx", status: "ok", priceChange24h: 0.8 },
    ],
  });
  assert.deepEqual(grouped.groups, ["DERIVATIVES"]);
  assert.equal(grouped.byGroup.DERIVATIVES.providers.length, 3);
});

test("confidence rewards independent evidence groups, not duplicate exchanges", () => {
  const cexOnly = {
    isActionable: true,
    direction: "Bullish",
    score: 75,
    marketEvidence: [
      { provider: "binance", status: "ok", priceChange24h: 1 },
      { provider: "bybit", status: "ok", priceChange24h: 1 },
      { provider: "okx", status: "ok", priceChange24h: 1 },
    ],
  };
  const crossSource = {
    ...cexOnly,
    marketEvidence: [
      ...cexOnly.marketEvidence,
      { provider: "dexscreener", status: "ok", priceChange24h: 1 },
      { provider: "alternative", status: "ok", priceChange24h: 1 },
    ],
  };
  assert.ok(calculateSignalConfidence(crossSource) > calculateSignalConfidence(cexOnly));
});

test("provider routing separates perpetual and DEX token workloads", () => {
  const perpetual = routeProviders("BTC", {});
  assert.ok(perpetual.providers.includes("binance"));
  assert.ok(perpetual.providers.includes("alternative"));
  assert.ok(!perpetual.providers.includes("goplus"));

  const dex = routeProviders("NEW", {
    assetType: "small_dex",
    contractAddress: "0xabc",
    verifiedOfficialRepository: false,
  });
  assert.deepEqual(dex.providers, ["dexscreener", "geckoterminal", "goplus", "honeypot"]);
  assert.ok(!dex.providers.includes("github"));
});

test("quality store records fields and evaluates real candle outcomes", async () => {
  const database = new Database(":memory:");
  initializeSignalQuality(database);
  const now = Date.now();
  const signalTime = now - 80 * 60 * 60 * 1000;
  const recorded = recordQualitySignal({
    isActionable: true,
    symbol: "BTC",
    venue: "Binance",
    direction: "Bullish",
    score: 82,
    lifecycleStage: "ACTIVE",
    entry: 100,
    stop: 90,
    tp1: 110,
    tp2: 120,
    price: 100,
    hasCoreData: true,
    evidence: { perpFlow: "Bullish" },
    conflicts: [],
    marketEvidence: [
      { provider: "binance", status: "ok", price: 100, priceChange24h: 1, openInterest: 10, funding: -0.02 },
      { provider: "dexscreener", status: "ok", price: 101, priceChange24h: 1.2, liquidity: 1000000 },
    ],
  }, { id: "quality-test-1", signalTime, source: "test" });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.evidenceGroups.includes("DERIVATIVES"), true);

  const candles = [
    { timestamp: signalTime + 60 * 60 * 1000, high: 111, low: 100, close: 108 },
    { timestamp: signalTime + 2 * 60 * 60 * 1000, high: 121, low: 107, close: 118 },
  ];
  const evaluation = await evaluateSignalOutcomes({
    now,
    fetchCandles: async () => candles,
  });
  assert.ok(evaluation.evaluated >= 1);
  const outcome = database.prepare("SELECT * FROM signal_quality_outcomes WHERE signal_id = ? AND horizon_key = '24h'").get("quality-test-1");
  assert.equal(outcome.tp1_hit, 1);
  assert.equal(outcome.tp2_hit, 1);
  assert.equal(outcome.stop_hit, 0);
  assert.equal(outcome.status, "TP2_HIT");
  assert.ok(outcome.mfe_percent > 0);
  assert.ok(outcome.mae_percent >= 0);

  const report = getSignalQualityReport({ lookbackDays: 365 });
  assert.equal(report.status, "insufficient_observations");
  assert.equal(report.horizons["24h"].statistics, null);
  database.close();
});
