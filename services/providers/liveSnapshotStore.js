"use strict";

const { applyFreshness, evaluateFreshness } = require("./freshness");
const { normalizeEvidence } = require("./evidence");
const { observe, setGauge } = require("../telemetry");

const snapshots = new Map();

function keyOf(provider, symbol) {
  return String(provider || "").toLowerCase() + ":" + String(symbol || "").toUpperCase().replace(/^\$/, "");
}

function fieldsOf(record) {
  const fields = {};
  for (const field of [
    "price", "markPrice", "indexPrice", "funding", "openInterest", "volume",
    "priceChange", "spotPrice", "perpPrice", "liquidity", "orderbook",
  ]) {
    if (record[field] !== null && record[field] !== undefined) fields[field] = record[field];
  }
  return fields;
}

function upsertSnapshot(input, now = Date.now()) {
  const evidence = normalizeEvidence({
    ...input,
    sourceType: "websocket",
    fetchedAt: input.fetchedAt || new Date(now).toISOString(),
    updatedAt: input.updatedAt || new Date(now).toISOString(),
    metadata: {
      ...(input.metadata || {}),
      sourceType: "websocket",
      transport: input.metadata?.transport || "WebSocket",
    },
  });
  const freshness = evaluateFreshness(evidence, now);
  const snapshot = {
    ...evidence,
    sourceType: "websocket",
    fetchedAt: evidence.fetchedAt,
    updatedAt: evidence.updatedAt,
    ageMs: freshness.ageMs,
    stale: !freshness.usable,
    usable: freshness.usable,
    freshness,
    fields: fieldsOf(evidence),
  };
  snapshots.set(keyOf(evidence.provider, evidence.symbol), snapshot);
  observe("perpsia_live_snapshot_age_ms", freshness.ageMs);
  setGauge("perpsia_live_snapshots_usable", [...snapshots.values()].filter((item) => item.usable).length);
  return snapshot;
}

function getSnapshot(provider, symbol, now = Date.now()) {
  const snapshot = snapshots.get(keyOf(provider, symbol));
  if (!snapshot) return null;
  const freshness = evaluateFreshness(snapshot, now, snapshot.freshness);
  return {
    ...snapshot,
    ageMs: freshness.ageMs,
    stale: !freshness.usable,
    usable: freshness.usable,
    freshness,
  };
}

function getUsableSnapshot(provider, symbol, now = Date.now()) {
  const snapshot = getSnapshot(provider, symbol, now);
  return snapshot?.usable ? snapshot : null;
}

function listSnapshots(now = Date.now()) {
  return [...snapshots.values()].map((item) => getSnapshot(item.provider, item.symbol, now));
}

function getSnapshotHealth(now = Date.now()) {
  const items = listSnapshots(now);
  return {
    total: items.length,
    usable: items.filter((item) => item.usable).length,
    stale: items.filter((item) => item.stale).length,
    snapshots: items.map((item) => ({
      provider: item.provider,
      symbol: item.symbol,
      sourceType: item.sourceType,
      ageMs: item.ageMs,
      stale: item.stale,
      usable: item.usable,
      freshnessClass: item.freshness?.freshnessClass || "default",
      fields: Object.keys(item.fields || {}),
    })),
  };
}

function clearSnapshots() {
  snapshots.clear();
  setGauge("perpsia_live_snapshots_usable", 0);
}

module.exports = {
  clearSnapshots,
  getSnapshot,
  getSnapshotHealth,
  getUsableSnapshot,
  keyOf,
  listSnapshots,
  upsertSnapshot,
};
