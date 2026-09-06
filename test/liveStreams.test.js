const test = require("node:test");
const assert = require("node:assert/strict");

const { StreamManager } = require("../services/providers/streamManager");
const {
  clearSnapshots,
  getSnapshot,
  getSnapshotHealth,
  upsertSnapshot,
} = require("../services/providers/liveSnapshotStore");
const { reconcileLiveAndRest } = require("../services/providers/registry");
const { calculateSignalConfidence } = require("../services/signalQuality");

function evidence(timestamp, overrides = {}) {
  return {
    provider: "binance",
    symbol: "BTC",
    marketType: "perpetual",
    timestamp,
    price: 100,
    funding: 0.0001,
    openInterest: 1000,
    orderbook: { bidVolume: 100, askVolume: 90, imbalance: 0.05 },
    status: "ok",
    ...overrides,
  };
}

test.beforeEach(() => clearSnapshots());
test.afterEach(() => clearSnapshots());

test("prefers one fresh WebSocket snapshot and prevents duplicate subscriptions", () => {
  let now = 1_000_000;
  let openCalls = 0;
  const handles = [];
  const manager = new StreamManager({
    now: () => now,
    openStream: (provider, symbol, onEvidence, options) => {
      openCalls += 1;
      options.onOpen();
      const handle = {
        close() {},
        emit(value) { onEvidence(value); },
      };
      handles.push(handle);
      return handle;
    },
  });

  const first = manager.subscribe("binance", "BTC");
  const second = manager.subscribe("binance", "$BTC");
  assert.equal(first, second);
  assert.equal(openCalls, 1);

  handles[0].emit(evidence(now));
  const snapshot = getSnapshot("binance", "BTC", now);
  assert.equal(snapshot.sourceType, "websocket");
  assert.equal(snapshot.usable, true);
  assert.equal(getSnapshotHealth(now).usable, 1);
  manager.stop();
});

test("falls back to fresh REST when WebSocket is stale and marks both stale unusable", () => {
  const now = Date.now();
  upsertSnapshot(evidence(now - 60_000), now);
  const rest = evidence(now, { sourceType: "rest" });
  const fallback = reconcileLiveAndRest("binance", { symbol: "BTC" }, [rest]);
  assert.equal(fallback[0].sourceType, "rest");
  assert.equal(fallback[0].metadata.reconciliation, "rest_fallback_stale_websocket");

  clearSnapshots();
  upsertSnapshot(evidence(now - 60_000), now);
  const staleRest = evidence(now - 180_000, { sourceType: "rest" });
  const unusable = reconcileLiveAndRest("binance", { symbol: "BTC" }, [staleRest]);
  assert.equal(unusable[0].usable, false);
  assert.equal(unusable[0].freshness.reason, "both live WebSocket and REST evidence are stale");
});

test("records material WebSocket/REST conflicts and stale evidence cannot raise confidence", () => {
  const now = Date.now();
  upsertSnapshot(evidence(now, { price: 110 }), now);
  const rest = evidence(now, { price: 100 });
  const reconciled = reconcileLiveAndRest("binance", { symbol: "BTC" }, [rest])[0];
  assert.ok(reconciled.metadata.conflicts.some((item) => item.field === "price"));

  const fresh = calculateSignalConfidence({
    score: 70,
    direction: "Bullish",
    marketEvidence: [{ provider: "alternative", marketType: "macro", priceChange: 2, status: "ok", freshness: { status: "fresh", usable: true } }],
  });
  const stale = calculateSignalConfidence({
    score: 70,
    direction: "Bullish",
    marketEvidence: [{ provider: "alternative", marketType: "macro", priceChange: 2, status: "ok", freshness: { status: "stale", usable: false } }],
  });
  assert.ok(stale <= fresh);
});
