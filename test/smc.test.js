const test = require("node:test");
const assert = require("node:assert/strict");

const { analyzeSMC } = require("../services/smcAnalysis");
const { analyzeTechnical } = require("../services/technicalAnalysis");
const { researchAsset } = require("../services/grokResearch");

function candle(timestamp, open, high, low, close, volume = 100) {
  return { timestamp, open, high, low, close, volume };
}

test("detects deterministic SMC structure from OHLCV without an LLM", () => {
  const candles = [];
  let price = 100;
  for (let index = 0; index < 80; index += 1) {
    const drift = index % 8 === 0 ? 2.5 : 0.6;
    const open = price;
    const close = price + drift;
    candles.push(candle(index, open, Math.max(open, close) + 0.5, Math.min(open, close) - 0.5, close, 100 + index * 2));
    price = close;
  }
  const result = analyzeSMC(candles);
  assert.equal(result.status, "available");
  assert.ok(["BULLISH", "NEUTRAL"].includes(result.direction));
  assert.ok(result.candleCount >= 80);
  assert.equal(typeof result.scoreAdjustment, "number");
});

test("technical context exposes TA and SMC outputs from the same candles", () => {
  const candles = Array.from({ length: 60 }, (_, index) => {
    const close = 100 + index;
    return candle(index, close - 0.5, close + 1, close - 1, close, 100 + index);
  });
  const result = analyzeTechnical(candles);
  assert.equal(result.status, "available");
  assert.equal(result.smc.status, "available");
  assert.equal(result.trend, "BULLISH");
  assert.ok(result.ema20 > 0);
});

test("Grok research is safely disabled without explicit enablement and a key", async () => {
  const priorEnabled = process.env.PERPSIA_ENABLE_GROK_RESEARCH;
  const priorKey = process.env.XAI_API_KEY;
  delete process.env.PERPSIA_ENABLE_GROK_RESEARCH;
  delete process.env.XAI_API_KEY;
  try {
    const result = await researchAsset({ symbol: "BTC", signal: {} });
    assert.equal(result.status, "disabled");
    assert.equal(result.provider, "grok");
  } finally {
    if (priorEnabled === undefined) delete process.env.PERPSIA_ENABLE_GROK_RESEARCH;
    else process.env.PERPSIA_ENABLE_GROK_RESEARCH = priorEnabled;
    if (priorKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = priorKey;
  }
});
