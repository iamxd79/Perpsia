"use strict";

const OpenAI = require("openai");
const { CircuitBreaker, executeWithResilience } = require("./resilience");

const breaker = new CircuitBreaker(3, 120000, { name: "OpenAI signal validation" });
const runtimeHealth = { requests: 0, successes: 0, unavailable: 0, lastStatus: "idle", lastRequestAt: null, lastError: null };
let clientState = { client: null, key: null };

function getClient(options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const timeout = Number(options.timeoutMs || process.env.OPENAI_SIGNAL_TIMEOUT_MS || 12000);
  const model = options.model || process.env.OPENAI_SIGNAL_MODEL || "gpt-5.5";
  const key = apiKey + ":" + timeout;
  if (!clientState.client || clientState.key !== key) {
    clientState.client = new OpenAI({ apiKey, timeout, maxRetries: 0 });
    clientState.key = key;
  }
  return { client: clientState.client, model };
}

function enabled(options = {}) {
  if (typeof options.enabled === "boolean") return options.enabled;
  return process.env.PERPSIA_ENABLE_OPENAI_SIGNAL_VALIDATION === "true";
}

function normalizeDirection(value) {
  const text = String(value || "").toUpperCase();
  if (text === "LONG" || text === "BULLISH") return "LONG";
  if (text === "SHORT" || text === "BEARISH") return "SHORT";
  return "NEUTRAL";
}

function normalize(response) {
  const parsed = JSON.parse(String(response?.output_text || "{}"));
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
  return {
    status: "available",
    provider: "openai",
    direction: normalizeDirection(parsed.direction),
    verdict: ["CONFIRM", "CHALLENGE", "INSUFFICIENT"].includes(parsed.verdict) ? parsed.verdict : "INSUFFICIENT",
    confidence,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String).slice(0, 5) : [],
    missingEvidence: Array.isArray(parsed.missingEvidence) ? parsed.missingEvidence.map(String).slice(0, 5) : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 5) : [],
    timestamp: Date.now(),
  };
}

function getOpenAISignalValidationHealth() {
  return { ...runtimeHealth, breaker: breaker.snapshot() };
}

async function validateSignal({ symbol, signal = {}, evidence = [], options = {} } = {}) {
  if (!enabled(options)) { if (!runtimeHealth.requests) runtimeHealth.lastStatus = "disabled"; return { status: "disabled", provider: "openai", direction: "NEUTRAL", confidence: 0 }; }
  const configured = getClient(options);
  if (!configured) { if (!runtimeHealth.requests) runtimeHealth.lastStatus = "unconfigured"; return { status: "disabled", provider: "openai", direction: "NEUTRAL", confidence: 0, reason: "OPENAI_API_KEY is not configured" }; }

  const compactEvidence = (Array.isArray(evidence) ? evidence : []).slice(0, 16).map((record) => ({
    provider: record.provider,
    status: record.status,
    marketType: record.marketType,
    price: record.price,
    priceChange: record.priceChange,
    funding: record.funding,
    openInterest: record.openInterest,
    orderbook: record.orderbook,
    spotPrice: record.spotPrice,
    perpPrice: record.perpPrice,
    securityRisk: record.securityRisk,
    metadata: record.metadata,
  }));

  try {
    runtimeHealth.requests += 1;
    runtimeHealth.lastRequestAt = new Date().toISOString();
    runtimeHealth.lastError = null;
    const response = await executeWithResilience(
      () => configured.client.responses.create({
        model: configured.model,
        input: [
          {
            role: "system",
            content: [{
              type: "input_text",
              text: "You are PerpsIA's independent signal validator. Use the supplied structured evidence as the primary source of truth. You must use web search to check current context and catalysts before proposing LONG, SHORT, or NEUTRAL. Never invent prices, entries, targets, stops, or facts. A directional proposal requires measurable evidence and must state missing evidence. Return only JSON.",
            }],
          },
          {
            role: "user",
            content: [{
              type: "input_text",
              text: JSON.stringify({
                task: "Validate the deterministic PerpsIA setup direction.",
                symbol,
                deterministicSignal: {
                  direction: signal.direction || "Neutral",
                  category: signal.category || "neutral",
                  score: signal.score ?? null,
                  reasons: signal.reasons || [],
                  conflicts: signal.conflicts || [],
                },
                evidence: compactEvidence,
              }),
            }],
          },
        ],
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        store: false,
        include: ["web_search_call.action.sources"],
        text: {
          format: {
            type: "json_schema",
            name: "perpsia_openai_signal_validation",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                direction: { type: "string", enum: ["LONG", "SHORT", "NEUTRAL"] },
                verdict: { type: "string", enum: ["CONFIRM", "CHALLENGE", "INSUFFICIENT"] },
                confidence: { type: "number" },
                reasons: { type: "array", items: { type: "string" } },
                missingEvidence: { type: "array", items: { type: "string" } },
                sources: { type: "array", items: { type: "string" } },
              },
              required: ["direction", "verdict", "confidence", "reasons", "missingEvidence", "sources"],
            },
          },
        },
      }),
      { breaker, retries: 1, baseDelayMs: 500, maxDelayMs: 2000 },
    );
    runtimeHealth.successes += 1;
    runtimeHealth.lastStatus = "available";
    return normalize(response);
  } catch (error) {
    runtimeHealth.unavailable += 1;
    runtimeHealth.lastStatus = "unavailable";
    runtimeHealth.lastError = String(error?.message || error);
    return {
      status: "unavailable",
      provider: "openai",
      direction: "NEUTRAL",
      confidence: 0,
      reason: String(error?.message || error),
      timestamp: Date.now(),
    };
  }
}

module.exports = { getOpenAISignalValidationHealth, validateSignal };
