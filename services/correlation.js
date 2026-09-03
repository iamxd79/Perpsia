const { executeSkill } = require("./cmcClient");

const CORRELATION_SKILL = "analyze_cross_asset_performance_divergence";
const DEFAULT_COMPARISON_ASSETS = [
  "BTC",
  "ETH",
  "BNB",
  "SOL",
  "XRP",
  "DOGE",
  "ADA",
  "AVAX",
];

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .replace(/^\$/, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function parseLookbackDays(lookback) {
  const match = String(lookback || "7").match(/\d+/);
  const days = Number.parseInt(match ? match[0] : "7", 10);
  return Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 7;
}

function parseToolResult(result) {
  const textBlock = result?.content?.find((item) => item.type === "text");

  if (result?.isError) {
    throw new Error(
      "CMC Skill Hub error: " +
        (textBlock?.text || "The provider returned an MCP tool error.")
    );
  }

  let parsed = result?.structuredContent;

  if (parsed === undefined) {
    if (!textBlock?.text) {
      return result;
    }

    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      throw new Error("CMC returned a non-JSON correlation response.");
    }
  }

  if (parsed?.result?.output && typeof parsed.result.output === "string") {
    try {
      parsed = JSON.parse(parsed.result.output);
    } catch {
      throw new Error("CMC returned an invalid nested correlation payload.");
    }
  }

  if (parsed?.result?.error) {
    throw new Error("CMC Skill Hub error: " + parsed.result.error);
  }

  if (parsed?.error) {
    throw new Error(
      "CMC Skill Hub error: " +
        (parsed.error.code ? parsed.error.code + ": " : "") +
        (parsed.error.message || "Unknown provider error")
    );
  }

  return parsed;
}

function unwrapData(payload) {
  return (
    payload?.result?.data?.data ||
    payload?.result?.data ||
    payload?.data ||
    payload
  );
}

function toFiniteNumber(value) {
  const scalar =
    value && typeof value === "object"
      ? value.value ??
        value.correlation ??
        value.correlation_coefficient ??
        value.total_return_pct ??
        value.return_pct ??
        value.change_pct
      : value;

  if (scalar === null || scalar === undefined || scalar === "") return null;

  const parsed = Number.parseFloat(
    String(scalar).replace(/,/g, "").replace(/[%−]/g, (value) => value === "−" ? "-" : "")
  );

  return Number.isFinite(parsed) ? parsed : null;
}

function readField(object, aliases) {
  if (!object || typeof object !== "object") return null;

  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(object, alias)) {
      return object[alias];
    }
  }

  return null;
}

function collectObjects(value, seen = new Set(), output = [], depth = 0) {
  if (value === null || typeof value !== "object" || depth > 8 || seen.has(value)) {
    return output;
  }

  seen.add(value);
  output.push(value);

  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, seen, output, depth + 1);
  } else {
    for (const child of Object.values(value)) {
      collectObjects(child, seen, output, depth + 1);
    }
  }

  return output;
}

function findArraysByKey(payload, aliases) {
  const wanted = new Set(aliases);
  const arrays = [];

  for (const object of collectObjects(payload)) {
    for (const [key, value] of Object.entries(object)) {
      if (wanted.has(String(key).toLowerCase()) && Array.isArray(value)) {
        arrays.push(value);
      }
    }
  }

  return arrays;
}

function normalizeDirection(value, returnPct) {
  const text = String(value || "").trim().toLowerCase();

  if (
    text === "bullish" ||
    text === "positive" ||
    text === "strength" ||
    text === "up"
  ) {
    return "Bullish";
  }

  if (
    text === "bearish" ||
    text === "negative" ||
    text === "weakness" ||
    text === "down"
  ) {
    return "Bearish";
  }

  if (returnPct !== null) {
    if (returnPct > 0) return "Bullish";
    if (returnPct < 0) return "Bearish";
  }

  return "Neutral";
}

function normalizePair(rawPair, baseSymbol, fallbackSymbol = null, fallbackCorrelation = null, fallbackSummary = null) {
  if (!rawPair && !fallbackSymbol) return null;

  const symbol = normalizeSymbol(
    readField(rawPair, [
      "symbol",
      "asset",
      "quote_asset",
      "comparison_asset",
      "ticker",
      "name",
    ]) || fallbackSymbol
  );
  const correlation = toFiniteNumber(
    readField(rawPair, [
      "correlation",
      "correlation_coefficient",
      "pearson_correlation",
      "corr",
    ]) ?? fallbackCorrelation
  );

  if (!symbol || symbol === baseSymbol || correlation === null) return null;

  const summary = fallbackSummary || rawPair || {};
  const returnPct = toFiniteNumber(
    readField(summary, [
      "total_return_pct",
      "return_pct",
      "price_change_pct",
      "change_pct",
      "performance_pct",
    ])
  );
  const direction = normalizeDirection(
    readField(summary, ["direction", "bias", "trend", "state", "performance"]),
    returnPct
  );
  const directionSign =
    direction === "Bullish" ? 1 : direction === "Bearish" ? -1 : 0;
  const expectedImpact = correlation * directionSign;

  return {
    symbol,
    correlation,
    strength: Math.abs(correlation),
    returnPct,
    direction,
    expectedImpact,
    source: "CMC_CROSS_ASSET_PERFORMANCE",
  };
}

function parseCorrelationPairs(payload, baseSymbol) {
  const data = unwrapData(payload);
  const report = data?.report || {};
  const correlationMap =
    report.correlation_to_base ||
    data?.correlation_to_base ||
    data?.correlations ||
    {};
  const summaries = report.asset_summaries || data?.asset_summaries || {};
  const pairsBySymbol = new Map();

  if (correlationMap && typeof correlationMap === "object" && !Array.isArray(correlationMap)) {
    for (const [symbol, correlation] of Object.entries(correlationMap)) {
      const pair = normalizePair(
        null,
        baseSymbol,
        symbol,
        correlation,
        summaries[symbol] || summaries[normalizeSymbol(symbol)] || null
      );
      if (pair) pairsBySymbol.set(pair.symbol, pair);
    }
  }

  const arrays = findArraysByKey(data, [
    "correlated_pairs",
    "correlations",
    "pairs",
    "comparisons",
    "assets",
  ]);

  for (const array of arrays) {
    for (const rawPair of array) {
      const pair = normalizePair(rawPair, baseSymbol);
      if (pair && !pairsBySymbol.has(pair.symbol)) {
        pairsBySymbol.set(pair.symbol, pair);
      }
    }
  }

  return [...pairsBySymbol.values()].sort(
    (a, b) => Math.abs(b.correlation) - Math.abs(a.correlation)
  );
}

function formatCorrelation(pair) {
  return pair.symbol + " (" + Number(pair.correlation).toFixed(2) + ")";
}

function buildCorrelationNarrative(
  pairs,
  symbol,
  divergenceState = null,
  baseReturnPct = null
) {
  const list = Array.isArray(pairs) ? pairs : [];
  const supportive = list.filter((pair) => pair.expectedImpact >= 0.5);
  const headwinds = list.filter((pair) => pair.expectedImpact <= -0.5);

  const prefix =
    "$" +
    symbol +
    (baseReturnPct !== null
      ? " returned " + Number(baseReturnPct).toFixed(2) + "% over the window. "
      : " has cross-asset context. ");

  if (supportive.length && headwinds.length) {
    return (
      prefix +
      "The thesis is supported by " +
      supportive.slice(0, 3).map(formatCorrelation).join(", ") +
      ", but faces headwind from " +
      headwinds.slice(0, 3).map(formatCorrelation).join(", ") +
      "."
    );
  }

  if (supportive.length) {
    return (
      prefix +
      "The thesis is strengthened by " +
      supportive.slice(0, 4).map(formatCorrelation).join(", ") +
      "."
    );
  }

  if (headwinds.length) {
    return (
      prefix +
      "The thesis faces headwind from " +
      headwinds.slice(0, 4).map(formatCorrelation).join(", ") +
      "."
    );
  }

  if (divergenceState && divergenceState !== "broadly_tracking") {
    return (
      prefix +
      "Cross-asset behavior is " +
      String(divergenceState).replaceAll("_", " ") +
      "; treat the relationship as conditional."
    );
  }

  return prefix + "No material cross-asset confirmation was detected.";
}

function unavailable(symbol, reason) {
  return {
    status: "unavailable",
    symbol,
    lookbackDays: 7,
    pairs: [],
    bullishCorrelations: [],
    bearishCorrelations: [],
    supportive: [],
    headwinds: [],
    scoreAdjust: 0,
    rationale: "Correlation analysis unavailable: " + String(reason),
    error: String(reason),
  };
}

async function analyzeCorrelation(symbol, lookback = "7d", options = {}) {
  const baseSymbol = normalizeSymbol(symbol);
  const lookbackDays = parseLookbackDays(lookback);
  const execute = options.executeSkill || executeSkill;

  if (!baseSymbol) return unavailable("UNKNOWN", "No base symbol was provided.");

  const requestedAssets = Array.isArray(options.quoteAssets)
    ? options.quoteAssets
    : DEFAULT_COMPARISON_ASSETS;
  const quoteAssets = [...new Set(
    requestedAssets
      .map((asset) =>
        typeof asset === "string"
          ? normalizeSymbol(asset)
          : normalizeSymbol(asset?.symbol || asset?.ticker)
      )
      .filter((asset) => asset && asset !== baseSymbol)
  )]
    .slice(0, 8)
    .map((asset) => ({ symbol: asset, asset_type: "crypto" }));

  try {
    const rawResult = await execute(CORRELATION_SKILL, {
      request_class: "cross_asset_chart",
      base_asset: baseSymbol,
      quote_assets: quoteAssets,
      lookback_days: lookbackDays,
    });
    const parsed = parseToolResult(rawResult);
    const data = unwrapData(parsed);
    const report = data?.report || {};
    const pairs = parseCorrelationPairs(parsed, baseSymbol);
    const baseSummary =
      report.asset_summaries?.[baseSymbol] ||
      data?.asset_summaries?.[baseSymbol] ||
      {};
    const baseReturnPct = toFiniteNumber(
      readField(baseSummary, [
        "total_return_pct",
        "return_pct",
        "price_change_pct",
      ])
    );
    const divergenceState =
      report.divergence_state || data?.divergence_state || null;
    const bullishCorrelations = pairs.filter((pair) => pair.correlation > 0.7);
    const bearishCorrelations = pairs.filter((pair) => pair.correlation < -0.5);
    const supportive = pairs.filter((pair) => pair.expectedImpact >= 0.5);
    const headwinds = pairs.filter((pair) => pair.expectedImpact <= -0.5);
    const scoreAdjust = Math.max(
      -12,
      Math.min(12, supportive.length * 4 - headwinds.length * 4)
    );

    if (!pairs.length) {
      return {
        status: "insufficient_data",
        symbol: baseSymbol,
        lookbackDays,
        pairs: [],
        bullishCorrelations,
        bearishCorrelations,
        supportive,
        headwinds,
        scoreAdjust: 0,
        baseReturnPct,
        divergenceState,
        rationale: buildCorrelationNarrative(
          pairs,
          baseSymbol,
          divergenceState,
          baseReturnPct
        ),
        freshnessNote: data?.freshness_note || null,
        dataQuality: data?.data_quality || null,
      };
    }

    return {
      status: "available",
      symbol: baseSymbol,
      lookbackDays,
      pairs,
      bullishCorrelations,
      bearishCorrelations,
      supportive,
      headwinds,
      scoreAdjust,
      baseReturnPct,
      divergenceState,
      rationale: buildCorrelationNarrative(
        pairs,
        baseSymbol,
        divergenceState,
        baseReturnPct
      ),
      freshnessNote: data?.freshness_note || null,
      dataQuality: data?.data_quality || null,
      summary: data?.summary || null,
    };
  } catch (error) {
    return unavailable(baseSymbol, error.message);
  }
}

module.exports = {
  analyzeCorrelation,
  parseCorrelationPairs,
  buildCorrelationNarrative,
  normalizeSymbol,
};
