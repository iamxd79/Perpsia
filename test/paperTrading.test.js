const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchMarkPrice, normalizeSymbol, parsePaperCommand } = require("../services/paperTrading");

test("parses LONG paper orders with risk levels", () => {
  const order = parsePaperCommand("/paper long BTCUSDT 1000 5 sl=62000 tp=65000");
  assert.deepEqual(order, {
    action: "open",
    direction: "LONG",
    symbol: "BTCUSDT",
    margin: 1000,
    leverage: 5,
    stopLoss: 62000,
    takeProfit: 65000,
    venue: "Binance",
  });
});

test("parses SHORT orders and management commands", () => {
  const order = parsePaperCommand("short ETH 500 leverage 3 stop_loss=3500 take_profit=3200 venue=Bybit");
  assert.equal(order.direction, "SHORT");
  assert.equal(order.symbol, "ETHUSDT");
  assert.equal(order.leverage, 3);
  assert.equal(order.stopLoss, 3500);
  assert.equal(order.takeProfit, 3200);
  assert.equal(order.venue, "Bybit");
  assert.deepEqual(parsePaperCommand("/paper positions"), { action: "positions" });
  assert.deepEqual(parsePaperCommand("/paper stats"), { action: "stats" });
  assert.deepEqual(parsePaperCommand("/paper close BTC"), { action: "close", symbol: "BTCUSDT" });
});

test("normalizes symbols for USDT perpetuals", () => {
  assert.equal(normalizeSymbol("$sol-usdt"), "SOLUSDT");
  assert.equal(normalizeSymbol("BTC"), "BTCUSDT");
});

test("falls back from a restricted Binance price endpoint", async () => {
  const calls = [];
  const price = await fetchMarkPrice("BTCUSDT", "Binance", async (url) => {
    calls.push(url);
    if (url.includes("binance")) return { ok: false, status: 451, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ result: { list: [{ lastPrice: "64000" }] } }) };
  });
  assert.equal(price, 64000);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /bybit/);
});