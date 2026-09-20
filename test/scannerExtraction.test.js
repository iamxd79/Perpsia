const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyCandidate, extractSymbolsFromScan } = require("../services/scannerV2");

test("extracts candidates from the live ranked-primary CMC report heading", () => {
  const payload = {
    result: {
      data: {
        decision_report: {
          analysis: [
            "### Scan Funnel Overview",
            "The scan completed.",
            "### Ranked Primary Candidates",
            "1.  **BTW (Long Exhaustion Risk):** review the setup.",
            "2.  **USDC (Watch):** review the setup.",
            "3.  **CASHCAT (Crowded Chop):** review the setup.",
            "### Secondary Candidates",
            "1.  **EUR:** extended review.",
          ].join(String.fromCharCode(10)),
        },
      },
    },
  };
  assert.deepEqual(extractSymbolsFromScan(payload), ["BTW", "USDC", "CASHCAT"]);
});


test("extracts symbols from the live ranked candidate table", () => {
  const payload = {
    result: {
      data: {
        data: {
          decision_report: {
            analysis: [
              "### Ranked Primary Candidate Queue",
              "| Rank | Token | Tier | Bias |",
              "|---|---|---|---|",
              "| 1 | AERO | Trend Supported | Bullish |",
              "| 2 | USDC | Watch | Bullish |",
              "| 3 | CASHCAT | Crowded Chop | Neutral |",
              "### Secondary Candidates",
              "| 1 | EUR | Review | Bearish |",
            ].join(String.fromCharCode(10)),
          },
        },
      },
    },
  };
  assert.deepEqual(extractSymbolsFromScan(payload), ["AERO", "USDC", "CASHCAT"]);
});

test("preserves normalized provider records returned in an evidence envelope", () => {
  const marketEvidence = [{
    provider: "binance",
    status: "ok",
    symbol: "BTC",
    marketType: "perpetual",
    price: 60000,
    perpPrice: 60000,
    metadata: { pair: "BTCUSDT" },
  }];
  const signal = classifyCandidate("BTC", {
    accumulation: {},
    perp: {},
    marketEvidence: { records: marketEvidence },
  });
  assert.deepEqual(signal.marketEvidence, marketEvidence);
});


test("extracts symbols from the CMC ranked candidate queue heading", () => {
  const payload = {
    result: {
      data: {
        data: {
          decision_report: {
            analysis: [
              "## Ranked Candidate Queue",
              "1.  **CAP (Squeeze tier):** review the setup.",
              "2.  **SOXL (Crowded chop tier):** review the setup.",
              "3.  **RBLX (Watch tier):** review the setup.",
              "## Secondary Candidates",
              "1.  **BR:** follow up.",
            ].join(String.fromCharCode(10)),
          },
        },
      },
    },
  };
  assert.deepEqual(extractSymbolsFromScan(payload), ["CAP", "SOXL", "RBLX"]);
});

test("skips null CMC fields and reads usable public perpetual evidence", () => {
  const signal = classifyCandidate("BTC", {
    accumulation: {},
    perp: { status: "unavailable" },
    marketEvidence: [
      { provider: "coinmarketcap", status: "ok", symbol: "BTC", price: null, funding: null, priceChange: null },
      { provider: "binance", status: "ok", symbol: "BTC", marketType: "perpetual", price: 60000, priceChange: 4, funding: -0.0005 },
    ],
  });
  assert.equal(signal.hasCoreData, true);
  assert.equal(signal.direction, "Bullish");
});

test("uses coherent public perpetual evidence when CMC perp analysis is unavailable", () => {
  const records = ["binance", "okx"].map((provider) => ({
    provider,
    status: "ok",
    symbol: "BTC",
    marketType: "perpetual",
    price: 60000,
    priceChange: 4,
    funding: -0.0005,
    orderbook: { imbalance: 0.15 },
    metadata: { openInterestChangePct: 6 },
  }));
  const signal = classifyCandidate("BTC", {
    accumulation: {},
    perp: { status: "unavailable" },
    marketEvidence: records,
  });
  assert.equal(signal.hasCoreData, true);
  assert.equal(signal.direction, "Bullish");
  assert.match(signal.reasons.join(" "), /coherent bullish setup/i);
});
test("turns coherent public evidence into actionable LONG and SHORT signals", () => {
  const buildEvidence = (priceChange) => [{
    provider: "binance",
    status: "ok",
    usable: true,
    symbol: "BTC",
    marketType: "perpetual",
    currentPrice: 60000,
    priceChange,
    funding: 0.0001,
    metadata: { openInterestChangePct: 50 },
  }];

  const long = classifyCandidate("BTC", {
    accumulation: "accumulation breakout transition",
    perp: "price_up_oi_up",
    mtf: "full bullish",
    marketEvidence: buildEvidence(4),
  });
  const short = classifyCandidate("BTC", {
    accumulation: "accumulation breakout transition",
    perp: "price_down_oi_up",
    mtf: "full bearish",
    marketEvidence: buildEvidence(-4),
  });

  assert.equal(long.direction, "Bullish");
  assert.equal(long.category, "long");
  assert.equal(long.isActionable, true);
  assert.equal(short.direction, "Bearish");
  assert.equal(short.category, "short");
  assert.equal(short.isActionable, true);
});
