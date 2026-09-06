"use strict";

const OpenAI = require("openai");
const {
  CircuitBreaker,
  executeWithResilience,
} = require("./resilience");

const DEFAULT_MODEL = "grok-4.6";
const clientState = { client: null, key: null };
const breaker = new CircuitBreaker(3, 120000, { name: "Grok research" });

const researchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    direction: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] },
    thesisAlignment: { type: "string", enum: ["SUPPORTIVE", "CONTRADICTORY", "MIXED", "UNKNOWN"] },
    confidence: { type: "number" },
    catalysts: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    narrative: { type: "string" },
    sentiment: { type: "string", enum: ["POSITIVE", "NEGATIVE", "MIXED", "NEUTRAL", "UNKNOWN"] },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          claim: { type: "string" },
        },
        required: ["url", "title", "claim"],
      },
    },
  },
  required: ["direction", "thesisAlignment", "confidence", "catalysts", "risks", "narrative", "sentiment", "sources"],
};

function enabled(options = {}) {
  return options.enabled === true || process.env.PERPSIA_ENABLE_GROK_RESEARCH === "true";
}

function getClient(options = {}) {
  const apiKey = options.apiKey || process.env.XAI_API_KEY;
  if (!apiKey) return null;
  const timeout = Number(options.timeoutMs || process.env.XAI_RESEARCH_TIMEOUT_MS || 12000);
  const model = options.model || process.env.XAI_MODEL || DEFAULT_MODEL;
  if (!clientState.client || clientState.key !== apiKey + ":" + timeout) {
    clientState.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL || "https://api.x.ai/v1",
      timeout,
      maxRetries: 0,
    });
    clientState.key = apiKey + ":" + timeout;
  }
  return { client: clientState.client, model };
}

function boundedList(value, limit = 5) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).slice(0, limit) : [];
}

function extractCitations(response, structuredSources = []) {
  const found = [];
  const add = (value) => {
    if (!value) return;
    const url = typeof value === "string" ? value : value.url || value.uri;
    if (url && /^https?:\/\//i.test(url) && !found.some((item) => item.url === url)) {
      found.push({ url, title: String(value.title || ""), claim: String(value.claim || "") });
    }
  };
  for (const source of structuredSources) add(source);
  for (const citation of response?.citations || []) add(citation);
  for (const item of response?.output || []) {
    for (const source of item?.action?.sources || []) add(source);
    for (const source of item?.sources || []) add(source);
  }
  return found.slice(0, 10);
}

function parseStructuredOutput(response) {
  const text = String(response?.output_text || "").trim();
  if (!text) throw new Error("Grok returned no research output");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Grok returned non-JSON research output");
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Grok research payload is not an object");
  return parsed;
}

function normalizeResearch(parsed, response) {
  const direction = ["BULLISH", "BEARISH", "NEUTRAL"].includes(parsed.direction) ? parsed.direction : "NEUTRAL";
  const thesisAlignment = ["SUPPORTIVE", "CONTRADICTORY", "MIXED", "UNKNOWN"].includes(parsed.thesisAlignment)
    ? parsed.thesisAlignment
    : "UNKNOWN";
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
  // Only citations returned by xAI's search tool count as verified evidence.
  // URLs typed by the model are retained for audit but never increase confidence.
  const sources = extractCitations(response, []);
  return {
    status: "available",
    provider: "grok",
    direction,
    thesisAlignment,
    confidence,
    catalysts: boundedList(parsed.catalysts),
    risks: boundedList(parsed.risks),
    narrative: String(parsed.narrative || "").slice(0, 800),
    sentiment: String(parsed.sentiment || "UNKNOWN"),
    citations: sources,
    citationCount: sources.length,
    claimedSources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 10) : [],
    timestamp: Date.now(),
    freshness: { status: "fresh", ageMs: 0, maxAgeMs: 15 * 60 * 1000 },
  };
}

async function researchAsset({ symbol, signal = {}, evidence = [], options = {} } = {}) {
  if (!enabled(options)) return { status: "disabled", provider: "grok", direction: "NEUTRAL", citationCount: 0 };
  const configured = getClient(options);
  if (!configured) return { status: "disabled", provider: "grok", direction: "NEUTRAL", citationCount: 0, reason: "XAI_API_KEY is not configured" };

  const safeEvidence = (Array.isArray(evidence) ? evidence : []).slice(0, 12).map((record) => ({
    provider: record.provider,
    status: record.status,
    marketType: record.marketType,
    price: record.price,
    priceChange: record.priceChange,
    funding: record.funding,
    openInterest: record.openInterest,
    liquidity: record.liquidity,
    securityRisk: record.securityRisk,
    metadata: {
      exchange: record.metadata?.exchange,
      classification: record.metadata?.classification,
      fearGreedValue: record.metadata?.fearGreedValue,
      repository: record.metadata?.repository,
    },
  }));

  try {
    const response = await executeWithResilience(
      () => configured.client.responses.create({
        model: configured.model,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: "You are PerpsIA's research layer. Search for fresh, attributable market information, catalysts, narratives and sentiment. Never invent facts, prices, targets or trade levels. Structured market data is the source of truth. Treat social posts as sentiment, not confirmation. Every factual claim must have a source URL. Return only the requested JSON.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  task: "Research fresh context for this asset and compare it with the existing deterministic signal.",
                  symbol: String(symbol || "").replace(/^\$/, "").toUpperCase(),
                  deterministicSignal: {
                    direction: signal.direction || "NEUTRAL",
                    score: signal.score ?? null,
                    marketState: signal.marketState || null,
                    conflicts: signal.conflicts || [],
                  },
                  observedEvidence: safeEvidence,
                }),
              },
            ],
          },
        ],
        tools: [
          { type: "web_search" },
          { type: "x_search" },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "perpsia_market_research",
            strict: true,
            schema: researchSchema,
          },
        },
      }),
      { breaker, retries: 1, baseDelayMs: 500, maxDelayMs: 2000 },
    );
    return normalizeResearch(parseStructuredOutput(response), response);
  } catch (error) {
    return {
      status: "unavailable",
      provider: "grok",
      direction: "NEUTRAL",
      citationCount: 0,
      reason: String(error?.message || error),
      timestamp: Date.now(),
    };
  }
}

module.exports = {
  DEFAULT_MODEL,
  researchAsset,
};
