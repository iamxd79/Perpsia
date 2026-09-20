"use strict";

const {
  CircuitBreaker,
  isRetryableError,
  withRetries,
} = require("../resilience");
const {
  normalizeEvidence,
  summarizeEvidence,
  unavailableEvidence,
} = require("./evidence");
const { getStreamDefinition } = require("./streams");
const { getSnapshot, getUsableSnapshot } = require("./liveSnapshotStore");
const { getStreamManager } = require("./streamManager");
const { increment } = require("../telemetry");
const { applyFreshness } = require("./freshness");

const definitions = new Map();
const caches = new Map();
const health = new Map();
const breakers = new Map();

function providerKey(provider, context = {}) {
  return String(context.cacheKey || context.symbol || "global").toUpperCase();
}

function retryAfterMs(error) {
  const value = error?.response?.headers?.["retry-after"] ?? error?.headers?.["retry-after"];
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function registerProvider(definition) {
  if (!definition || !definition.id || typeof definition.collect !== "function") {
    throw new TypeError("A provider requires an id and collect function");
  }
  const id = String(definition.id);
  definitions.set(id, {
    timeoutMs: 8000,
    retries: 1,
    cacheTtlMs: 15000,
    circuitThreshold: 4,
    circuitTimeoutMs: 60000,
    sourceConfidence: 0.75,
    ...definition,
    id,
  });
  health.set(id, {
    provider: id,
    status: "idle",
    successes: 0,
    failures: 0,
    lastLatencyMs: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    retryAfterMs: null,
  });
  breakers.set(id, new CircuitBreaker(
    definitions.get(id).circuitThreshold,
    definitions.get(id).circuitTimeoutMs,
    {
      name: id,
      failurePredicate: (error) =>
        isRetryableError(error) || error?.code === "NO_USABLE_RESPONSE",
    },
  ));
  return definitions.get(id);
}

function getProviderDefinitions() {
  return [...definitions.values()].map((definition) => ({
    id: definition.id,
    name: definition.name || definition.id,
    category: definition.category || "market",
    authentication: definition.authentication || "none",
    rateLimit: definition.rateLimit || "provider-defined",
    transport: definition.transport || "REST",
    cacheTtlMs: definition.cacheTtlMs,
  }));
}

function updateHealth(id, patch) {
  const current = health.get(id) || { provider: id };
  health.set(id, { ...current, ...patch });
}

function relativeDifference(left, right) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return Math.abs((a - b) / b);
}

function findMaterialConflicts(provider, live, rest) {
  const conflicts = [];
  const checks = [
    ["price", 0.005],
    ["openInterest", 0.05],
    ["funding", 0.0005],
  ];
  for (const [field, threshold] of checks) {
    const liveValue = live?.[field];
    const restValue = rest?.[field];
    if (liveValue === null || liveValue === undefined || restValue === null || restValue === undefined) continue;
    const difference = field === "funding"
      ? Math.abs(Number(liveValue) - Number(restValue))
      : relativeDifference(liveValue, restValue);
    if (difference !== null && difference >= threshold) {
      conflicts.push({
        provider,
        field,
        liveValue,
        restValue,
        difference,
      });
      increment("perpsia_provider_conflicts_total", { provider, field });
    }
  }
  const liveImbalance = Number(live?.orderbook?.imbalance);
  const restImbalance = Number(rest?.orderbook?.imbalance);
  if (Number.isFinite(liveImbalance) && Number.isFinite(restImbalance) && Math.abs(liveImbalance - restImbalance) >= 0.2) {
    conflicts.push({
      provider,
      field: "orderbook",
      liveValue: liveImbalance,
      restValue: restImbalance,
      difference: Math.abs(liveImbalance - restImbalance),
    });
    increment("perpsia_provider_conflicts_total", { provider, field: "orderbook" });
  }
  return conflicts;
}

function markBothStale(record, provider, live) {
  return {
    ...record,
    status: "stale",
    stale: true,
    usable: false,
    error: "Both WebSocket and REST evidence are stale",
    freshness: {
      ...(record.freshness || {}),
      status: "stale",
      usable: false,
      reason: "both live WebSocket and REST evidence are stale",
    },
    metadata: {
      ...(record.metadata || {}),
      sourceType: "rest",
      liveSnapshotAgeMs: live?.ageMs ?? null,
      reconciliation: "both_stale",
    },
  };
}

function reconcileLiveAndRest(id, context, restRecords) {
  const refreshedRestRecords = restRecords.map((item) => applyFreshness(item));
  if (!getStreamDefinition(id)) return refreshedRestRecords;
  const live = getSnapshot(id, context.symbol);
  const usableLive = getUsableSnapshot(id, context.symbol);
  const rest = refreshedRestRecords.find((item) => item?.symbol === String(context.symbol || "").toUpperCase()) || refreshedRestRecords[0] || null;
  if (usableLive) {
    const conflicts = findMaterialConflicts(id, usableLive, rest);
    const source = {
      ...usableLive,
      sourceType: "websocket",
      metadata: {
        ...(usableLive.metadata || {}),
        sourceType: "websocket",
        restReconciledAt: rest ? new Date().toISOString() : null,
        restTimestamp: rest?.timestamp || null,
        conflicts,
        reconciliation: rest ? conflicts.length ? "live_preferred_with_conflict" : "live_preferred" : "live_primary_rest_unavailable",
      },
    };
    return [source];
  }
  const restUsable = refreshedRestRecords.filter((item) => item?.usable !== false && item?.freshness?.status === "fresh" && item.status === "ok");
  if (restUsable.length) {
    increment("perpsia_rest_fallback_total", { provider: id, reason: live ? "stale_websocket" : "no_websocket_snapshot" });
    return refreshedRestRecords.map((item) => ({
      ...item,
      metadata: {
        ...(item.metadata || {}),
        sourceType: "rest",
        liveSnapshotAgeMs: live?.ageMs ?? null,
        reconciliation: live ? "rest_fallback_stale_websocket" : "rest_fallback_no_websocket",
      },
    }));
  }
  if (live) return refreshedRestRecords.map((item) => markBothStale(item, id, live));
  increment("perpsia_rest_fallback_total", { provider: id, reason: "no_live_data" });
  return restRecords;
}

async function collectProvider(id, context = {}) {
  const definition = definitions.get(id);
  if (!definition) {
    return [unavailableEvidence(id, context.symbol, new Error("Provider is not registered"))];
  }

  const key = providerKey(id, context);
  const cacheKey = id + ":" + key;
  const cached = caches.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    updateHealth(id, { status: "ok", cacheHits: (health.get(id)?.cacheHits || 0) + 1 });
    return reconcileLiveAndRest(id, context, cached.records);
  }

  const breaker = breakers.get(id);
  const startedAt = Date.now();
  try {
    updateHealth(id, { status: "checking", lastError: null });
    const result = await breaker.execute(() => withRetries(
      () => definition.collect({
        ...context,
        timeoutMs: context.timeoutMs || definition.timeoutMs,
      }),
      {
        retries: context.retries ?? definition.retries,
        baseDelayMs: 250,
        maxDelayMs: 2500,
        retryPredicate: definition.retryPredicate || isRetryableError,
      },
    ));
    const values = (Array.isArray(result) ? result : [result])
      .filter(Boolean)
      .map((item) => normalizeEvidence({
        provider: id,
        sourceConfidence: definition.sourceConfidence,
        ...item,
        provider: id,
        symbol: item.symbol || context.symbol,
      }));
    const records = values.length
      ? values
      : [unavailableEvidence(id, context.symbol, new Error("Provider returned no evidence"))];
    caches.set(cacheKey, {
      records,
      expiresAt: Date.now() + definition.cacheTtlMs,
      createdAt: Date.now(),
    });
    updateHealth(id, {
      status: records.some((item) => item.status === "ok") ? "ok" : "degraded",
      successes: (health.get(id)?.successes || 0) + 1,
      lastSuccessAt: new Date().toISOString(),
      lastLatencyMs: Date.now() - startedAt,
      lastError: null,
      retryAfterMs: null,
    });
    return reconcileLiveAndRest(id, context, records);
  } catch (error) {
    const retryMs = retryAfterMs(error);
    updateHealth(id, {
      status: breaker.state === "OPEN" ? "circuit_open" : "degraded",
      failures: (health.get(id)?.failures || 0) + 1,
      lastFailureAt: new Date().toISOString(),
      lastLatencyMs: Date.now() - startedAt,
      lastError: String(error?.message || error),
      retryAfterMs: retryMs,
      circuit: breaker.snapshot(),
    });
    if (cached?.records?.length) {
      const stale = cached.records.map((item) => ({
        ...item,
        status: "stale",
        error: String(error?.message || error),
        freshness: {
          ...item.freshness,
          status: "stale",
          ageMs: Math.max(0, Date.now() - item.timestamp),
        },
      }));
      return reconcileLiveAndRest(id, context, stale);
    }
    return reconcileLiveAndRest(id, context, [unavailableEvidence(id, context.symbol, error, {
      retryAfterMs: retryMs,
      circuit: breaker.snapshot(),
    })]);
  }
}

async function collectProviders(ids, context = {}) {
  const providerIds = (ids || [...definitions.keys()])
    .map((id) => String(id))
    .filter((id, index, list) => list.indexOf(id) === index);
  const groups = await Promise.all(providerIds.map((id) => collectProvider(id, context)));
  return groups.flat();
}

function getProviderHealth() {
  const streamHealth = new Map(getStreamManager().getProviderHealth().map((item) => [item.provider, item]));
  return [...definitions.keys()].map((id) => ({
    ...(health.get(id) || { provider: id, status: "idle" }),
    circuit: breakers.get(id)?.snapshot() || null,
    websocket: streamHealth.get(id) || {
      status: getStreamDefinition(id) ? "idle" : "unsupported",
      reconnectCount: 0,
      currentSubscriptions: 0,
      staleStream: false,
      streams: [],
    },
  }));
}

function clearProviderCache(providerId) {
  for (const key of caches.keys()) {
    if (!providerId || key.startsWith(String(providerId) + ":")) caches.delete(key);
  }
}

function getEvidenceSummary(records) {
  return summarizeEvidence(records);
}

module.exports = {
  clearProviderCache,
  collectProvider,
  collectProviders,
  getEvidenceSummary,
  getProviderDefinitions,
  getProviderHealth,
  findMaterialConflicts,
  reconcileLiveAndRest,
  registerProvider,
};
