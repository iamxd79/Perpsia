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
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    retryAfterMs: null,
  });
  breakers.set(id, new CircuitBreaker(
    definitions.get(id).circuitThreshold,
    definitions.get(id).circuitTimeoutMs,
    { name: id },
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
    return cached.records;
  }

  const breaker = breakers.get(id);
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
      lastError: null,
      retryAfterMs: null,
    });
    return records;
  } catch (error) {
    const retryMs = retryAfterMs(error);
    updateHealth(id, {
      status: breaker.state === "OPEN" ? "circuit_open" : "degraded",
      failures: (health.get(id)?.failures || 0) + 1,
      lastFailureAt: new Date().toISOString(),
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
      return stale;
    }
    return [unavailableEvidence(id, context.symbol, error, {
      retryAfterMs: retryMs,
      circuit: breaker.snapshot(),
    })];
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
  return [...definitions.keys()].map((id) => ({
    ...(health.get(id) || { provider: id, status: "idle" }),
    circuit: breakers.get(id)?.snapshot() || null,
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
  registerProvider,
};
