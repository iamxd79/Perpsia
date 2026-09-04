const test = require("node:test");
const assert = require("node:assert/strict");

const { routeIntent, routeIntentLocally } = require("../services/intentRouter");

test("routes natural analysis and venue requests without an API call", () => {
  assert.deepEqual(routeIntentLocally("Analyze SOL"), {
    intent: "analyze_asset",
    symbol: "SOL",
    venue: null,
    confidence: 1,
  });
  assert.equal(routeIntentLocally("Analyze BTC on Hyperliquid").venue, "Hyperliquid");
});

test("routes natural scan, compare, alpha, tracking, and history requests", () => {
  assert.equal(routeIntentLocally("Scan the market").intent, "scan_market");
  assert.equal(routeIntentLocally("Find setups on Bybit").venue, "Bybit");
  assert.deepEqual(routeIntentLocally("Compare SOL vs ETH").symbols, ["SOL", "ETH"]);
  assert.equal(routeIntentLocally("Show early alpha").intent, "alpha");
  assert.equal(routeIntentLocally("Track JUP").intent, "watchlist_add");
  assert.equal(routeIntentLocally("How has BTC changed").intent, "history");
});

test("routes natural risk settings", () => {
  assert.deepEqual(routeIntentLocally("I have $500, risk 1%, max leverage 5x"), {
    intent: "set_risk",
    capital: 500,
    riskPercent: 1,
    maxLeverage: 5,
    confidence: 1,
  });
});

test("returns unknown without OpenAI credentials when no local intent matches", async () => {
  const prior = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.deepEqual(await routeIntent("make it interesting"), { intent: "unknown", confidence: 0 });
  } finally {
    if (prior === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prior;
  }
});
