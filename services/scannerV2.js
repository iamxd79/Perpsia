// ==========================================
// PERPSIA SCANNER V2 - PRODUCTION CONNECTION
// ==========================================
// Integrates live CMC Skill Hub execution with fallback caching

const { executeSkill } = require("./cmcClient");
const { buildCMCParams } = require("./exchangeAdapter");
const { RequestQueue } = require("./queue");

const ACTIVE_SIGNAL_SCORE = 70;
const WATCHLIST_SCORE = 40;
const MAX_SCAN_CANDIDATES = 8;

// Global request queue: 1 concurrent skill call to avoid overwhelming CMC
const skillQueue = new RequestQueue(1, 3);

// Simple in-memory cache for fallback
const resultCache = new Map();

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase();
}

function parseToolResult(result) {
  const textBlock = result?.content?.find((item) => item.type === "text");

  if (!textBlock?.text) {
    throw new Error("No text payload returned by CMC Skill Hub");
  }

  try {
    return JSON.parse(textBlock.text);
  } catch {
    console.error("Failed to parse CMC response:", textBlock.text);
    throw new Error("CMC response was not valid JSON");
  }
}

function getCachedResult(cacheKey) {
  const cached = resultCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < 3600000) {
    // 1h cache
    return cached.data;
  }

  resultCache.delete(cacheKey);
  return null;
}

function setCachedResult(cacheKey, data) {
  resultCache.set(cacheKey, {
    data,
    timestamp: Date.now(),
  });
}

/**
 * Execute CMC skill with fallback to cache
 */
async function executeSkillWithFallback(skillName, params, onProgress) {
  const cacheKey = `${skillName}:${JSON.stringify(params)}`;

  try {
    await onProgress?.({
      percent: 0,
      stage: skillName,
      message: `🔗 Executing $${params.symbol || skillName}...`,
    });

    const result = await skillQueue.add(async () => {
      return await executeSkill(skillName, params);
    });

    const parsed = parseToolResult(result);
    setCachedResult(cacheKey, parsed);

    return parsed;
  } catch (error) {
    console.error(`CMC skill failed: ${skillName}`, error.message);

    const cached = getCachedResult(cacheKey);

    if (cached) {
      console.log(`Using cached result for ${skillName}`);

      await onProgress?.({
        percent: 0,
        stage: skillName,
        message: `⚠️ CMC offline, using cached data for ${params.symbol || skillName}...`,
      });

      return cached;
    }

    throw new Error(
      `${skillName} failed and no cached result available: ${error.message}`
    );
  }
}

function getReportText(payload) {
  const report = payload?.result?.data?.decision_report;

  return `${report?.conclusion || ""}

${report?.analysis || ""}`;
}

function textIncludesAny(text, words) {
  if (!text) return false;
  return words.some((word) => text.toLowerCase().includes(word.toLowerCase()));
}

function parseNumber(text, regex) {
  if (!text) return null;

  const match = text.match(regex);
  if (!match) return null;

  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function cleanRead(text) {
  if (!text) return "No clean market summary returned.";

  return text
    .replace(/futures CVD latest_delta.*$/i, "")
    .replace(/spot CVD latest_delta.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSymbolsFromScan(scanPayload) {
  const text = getReportText(scanPayload);
  const rawJson = JSON.stringify(scanPayload);
  const combinedText = `${text}\n${rawJson}`;

  const matches = [
    ...combinedText.matchAll(/\*\*([A-Z0-9]{2,15})\b/g),
    ...combinedText.matchAll(/\$([A-Z0-9]{2,15})\b/g),
    ...combinedText.matchAll(/\b([A-Z0-9]{2,15})\s+\(final score/gi),
    ...combinedText.matchAll(/symbol["']?\s*:\s*["']([A-Z0-9]{2,15})["']/gi),
    ...combinedText.matchAll(/asset["']?\s*:\s*["']([A-Z0-9]{2,15})["']/gi),
    ...combinedText.matchAll(/ticker["']?\s*:\s*["']([A-Z0-9]{2,15})["']/gi),
  ];

  const blacklist = [
    "OI",
    "CVD",
    "USD",
    "USDT",
    "CMC",
    "APY",
    "TVL",
    "JSON",
    "NULL",
    "TRUE",
    "FALSE",
    "LONG",
    "SHORT",
    "NEUTRAL",
    "WATCHLIST",
  ];

  return [
    ...new Set(
      matches
        .map((match) => normalizeSymbol(match[1]))
        .filter(Boolean)
    ),
  ]
    .filter((symbol) => !blacklist.includes(symbol))
    .slice(0, MAX_SCAN_CANDIDATES);
}

function buildConfirmationNeeded({
  direction,
  oiChange,
  mtfBullish,
  mtfBearish,
  orderbookBullish,
  orderbookBearish,
  isOverextended,
}) {
  const confirmationNeeded = [];

  if (oiChange === null || oiChange < 40) {
    confirmationNeeded.push("Fresh OI expansion with price confirmation");
  }

  if (direction === "Bullish" && !mtfBullish) {
    confirmationNeeded.push("Cleaner bullish multi-timeframe alignment");
  }

  if (direction === "Bearish" && !mtfBearish) {
    confirmationNeeded.push("Cleaner bearish multi-timeframe alignment");
  }

  if (direction === "Bullish" && !orderbookBullish) {
    confirmationNeeded.push("Stronger buyer support in the orderbook");
  }

  if (direction === "Bearish" && !orderbookBearish) {
    confirmationNeeded.push("Stronger seller pressure in the orderbook");
  }

  if (isOverextended) {
    confirmationNeeded.push("Price reset before considering an entry");
  }

  if (!confirmationNeeded.length) {
    confirmationNeeded.push("Sustained price confirmation");
  }

  return confirmationNeeded;
}

function classifyCandidate(symbol, packs) {
  symbol = normalizeSymbol(symbol);

  const accumulationText = getReportText(packs.accumulation);
  const perpText = getReportText(packs.perp);
  const orderbookText = packs.orderbook ? getReportText(packs.orderbook) : "";
  const mtfText = packs.mtf ? getReportText(packs.mtf) : "";

  const allText = `
${accumulationText}
${perpText}
${orderbookText}
${mtfText}
`;

  const price = parseNumber(allText, /current price\s+([0-9.]+)/i);
  const funding = parseNumber(allText, /funding\s+(-?[0-9.]+)%/i);
  const priceChange = parseNumber(allText, /price change\s+(-?[0-9.]+)%/i);
  const oiChange = parseNumber(allText, /OI change\s+(-?[0-9.]+)%/i);
  const upside = parseNumber(allText, /top upside pressure is\s+([0-9.]+)/i);
  const downside = parseNumber(allText, /top downside pressure is\s+([0-9.]+)/i);

  const hasCoreData =
    price !== null &&
    priceChange !== null &&
    oiChange !== null &&
    funding !== null;

  const isEarly = textIncludesAny(accumulationText, [
    "warming",
    "starting to break out",
    "breakout transition",
    "near the prior range high",
    "accumulation",
  ]);

  const isOverextended =
    textIncludesAny(accumulationText, [
      "already overextended",
      "overextended",
    ]) ||
    (priceChange !== null && Math.abs(priceChange) > 100);

  const bullishPerp = textIncludesAny(perpText, [
    "price_up_oi_up",
    "short squeeze",
    "spot_buying_confirms_price_strength",
    "continuation to the upside",
    "spot-led upside",
  ]);

  const bearishPerp = textIncludesAny(perpText, [
    "price_down_oi_up",
    "spot_selling_confirms_price_weakness",
    "continuation to the downside",
    "spot-led downside",
  ]);

  const mtfBullish = textIncludesAny(mtfText, ["full bullish", "bullish bias"]);

  const mtfBearish = textIncludesAny(mtfText, ["full bearish", "bearish bias"]);

  const orderbookBullish = textIncludesAny(orderbookText, [
    "buyers are defending",
    "bid support",
    "bid_support",
  ]);

  const orderbookBearish = textIncludesAny(orderbookText, [
    "sellers are capping",
    "ask overhang",
    "ask_overhang",
  ]);

  const oiExpanding = oiChange !== null && oiChange >= 40;
  const oiDeclining = oiChange !== null && oiChange < 0;
  const deeplyNegativeFunding = funding !== null && funding <= -0.1;
  const extremelyNegativeFunding = funding !== null && funding <= -1;
  const elevatedFunding = funding !== null && funding >= 0.1;
  const priceHeavyDown = priceChange !== null && priceChange <= -30;
  const priceStrongUp = priceChange !== null && priceChange >= 30;

  let direction = "Neutral";
  let category = "neutral";
  let marketState = "Neutral / No Trade";
  let score = 0;

  const reasons = [];
  const conflicts = [];

  if (bullishPerp && !bearishPerp) direction = "Bullish";
  if (bearishPerp && !bullishPerp) direction = "Bearish";

  if (bullishPerp && bearishPerp) {
    conflicts.push("Perp flow contains both bullish and bearish evidence.");
  }

  if (isEarly) {
    score += 20;
    reasons.push("Early accumulation or breakout-transition structure is present.");
  }

  if (oiExpanding) {
    score += 20;
    reasons.push(`Open interest expanded ${oiChange}%, showing fresh derivatives activity.`);
  }

  if (oiDeclining) {
    score -= 10;
    reasons.push(`Open interest declined ${oiChange}%, so fresh positioning is not confirming yet.`);
  }

  if (deeplyNegativeFunding) {
    score += bullishPerp ? 20 : 5;
    reasons.push("Funding is deeply negative, creating potential short-squeeze pressure.");
  }

  if (extremelyNegativeFunding) {
    score -= 10;
    reasons.push("Funding is extremely negative, so positioning is unstable and squeeze risk is elevated.");
  }

  if (elevatedFunding) {
    score += bearishPerp ? 15 : 0;
    reasons.push("Funding is elevated, showing possible crowded long positioning.");
  }

  if (bullishPerp) {
    score += 15;
    reasons.push("Perp structure shows bullish pressure.");
  }

  if (bearishPerp) {
    score += 15;
    reasons.push("Perp structure shows bearish pressure.");
  }

  if (mtfBullish) {
    score += direction === "Bullish" ? 15 : -10;
    reasons.push("Multi-timeframe trend alignment is bullish.");
  }

  if (mtfBearish) {
    score += direction === "Bearish" ? 15 : -10;
    reasons.push("Multi-timeframe trend alignment is bearish.");
  }

  if (direction === "Bullish" && mtfBearish) {
    conflicts.push("Bullish thesis conflicts with bearish multi-timeframe trend.");
  }

  if (direction === "Bearish" && mtfBullish) {
    conflicts.push("Bearish thesis conflicts with bullish multi-timeframe trend.");
  }

  if (orderbookBullish) {
    score += direction === "Bullish" ? 10 : -5;
    reasons.push("Orderbook shows buyer defense.");
  }

  if (orderbookBearish) {
    score += direction === "Bearish" ? 10 : -5;
    reasons.push("Orderbook shows seller pressure.");
  }

  if (priceHeavyDown) {
    score -= 5;
    reasons.push(`Price is already down ${priceChange}%, so reversal confirmation is required.`);
  }

  if (priceStrongUp) {
    score -= isOverextended ? 25 : 5;
    reasons.push(`Price is already up ${priceChange}%, increasing chase risk.`);
  }

  if (isOverextended) {
    score -= 35;
    reasons.push("The asset appears overextended, increasing pullback or reversal risk.");
  }

  score = Math.max(0, Math.min(100, score));

  if (!hasCoreData) {
    marketState = "Insufficient Data";
    category = "neutral";
    direction = "Neutral";
    score = 0;
  } else if (isOverextended) {
    marketState = "Overextended / Avoid Chasing";
    category = "neutral";
  } else if (score >= ACTIVE_SIGNAL_SCORE && direction === "Bullish") {
    marketState = "Active Long Candidate";
    category = "long";
  } else if (score >= ACTIVE_SIGNAL_SCORE && direction === "Bearish") {
    marketState = "Active Short Candidate";
    category = "short";
  } else if (score >= WATCHLIST_SCORE && direction !== "Neutral") {
    if (direction === "Bullish" && deeplyNegativeFunding) {
      marketState = "Squeeze Watch";
    } else if (direction === "Bearish" && elevatedFunding) {
      marketState = "Long Unwind / Short Watch";
    } else if (direction === "Bearish" && deeplyNegativeFunding) {
      marketState = "Caution Short / Squeeze Risk";
    } else {
      marketState = "Watchlist";
    }

    category = "watchlist";
  } else {
    marketState = "Neutral / No Trade";
    category = "neutral";
  }

  const isActionable =
    hasCoreData &&
    score >= ACTIVE_SIGNAL_SCORE &&
    (category === "long" || category === "short") &&
    !isOverextended;

  const confirmationNeeded = buildConfirmationNeeded({
    direction,
    oiChange,
    mtfBullish,
    mtfBearish,
    orderbookBullish,
    orderbookBearish,
    isOverextended,
  });

  const entry =
    isActionable && direction === "Bullish" && downside && price
      ? `${(downside * 1.01).toFixed(6)} - ${price.toFixed(6)}`
      : isActionable && direction === "Bearish" && upside && price
      ? `${price.toFixed(6)} - ${upside.toFixed(6)}`
      : "Wait for confirmation";

  const tp1 =
    isActionable && direction === "Bullish" && upside
      ? upside.toString()
      : isActionable && direction === "Bearish" && downside
      ? downside.toString()
      : "N/A";

  const tp2 =
    isActionable && direction === "Bullish" && upside
      ? (upside * 1.08).toFixed(6)
      : isActionable && direction === "Bearish" && downside
      ? (downside * 0.92).toFixed(6)
      : "N/A";

  const stop =
    isActionable && direction === "Bullish" && downside
      ? (downside * 0.985).toFixed(6)
      : isActionable && direction === "Bearish" && upside
      ? (upside * 1.015).toFixed(6)
      : "N/A";

  return {
    symbol,
    direction,
    category,
    marketState,
    score,

    hasCoreData,
    isActionable,
    confirmationNeeded,

    evidence: {
      perpFlow:
        bullishPerp && bearishPerp
          ? "Mixed"
          : bullishPerp
          ? "Bullish"
          : bearishPerp
          ? "Bearish"
          : "Neutral",
      mtfTrend: mtfBullish ? "Bullish" : mtfBearish ? "Bearish" : "Unknown",
      orderbook: orderbookBullish ? "Bullish" : orderbookBearish ? "Bearish" : "Unknown",
      fundingState: deeplyNegativeFunding
        ? "Negative / Short-Squeeze Fuel"
        : elevatedFunding
        ? "Elevated / Long-Crowding Risk"
        : "Normal",
      oiState: oiExpanding ? "Expansion" : oiDeclining ? "Declining" : "Flat / Weak",
    },

    conflicts,

    price,
    priceChange,
    oiChange,
    funding,

    upside,
    downside,

    entry,
    tp1,
    tp2,
    stop,

    reasons,

    summary: cleanRead(
      packs.perp?.result?.data?.decision_report?.conclusion
    ),
  };
}

/**
 * Run market scan with live CMC Skill Hub (production version)
 */
async function runMarketScan(venue = "Binance", onProgress = async () => {}) {
  await onProgress({
    percent: 10,
    stage: "Market Scanner",
    message: "🔎 Scanning the perpetual market...",
  });

  const scanParams = buildCMCParams("", venue, { preview: true });

  const rawScan = await executeSkillWithFallback(
    "altcoin_scanner_perp",
    scanParams,
    onProgress
  );

  const scanPayload = rawScan;
  const symbols = extractSymbolsFromScan(scanPayload);

  if (!symbols.length) {
    console.error(
      "No symbols extracted from altcoin_scanner_perp output:",
      JSON.stringify(scanPayload, null, 2)
    );

    throw new Error("No candidates extracted from CMC Skill Hub scan output.");
  }

  await onProgress({
    percent: 25,
    stage: "Candidate Detection",
    message: `✅ ${symbols.length} candidates detected.`,
  });

  const results = [];
  const errors = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];

    const basePercent = 25 + Math.round((i / symbols.length) * 60);

    try {
      await onProgress({
        percent: basePercent,
        stage: `$${symbol} Early Structure`,
        message: `🧠 Screening $${symbol} accumulation structure...`,
      });

      const accumParams = buildCMCParams(symbol, venue, {
        lookback_days: 14,
      });

      const accumulation = await executeSkillWithFallback(
        "detect_accumulation_breakout_transition",
        accumParams,
        onProgress
      );

      await onProgress({
        percent: basePercent + 5,
        stage: `$${symbol} Perp Structure`,
        message: `📊 Reading $${symbol} OI, funding, CVD and liquidations...`,
      });

      const perpParams = buildCMCParams(symbol, venue, {
        timeframe: "4h",
        liq_range: "3d",
        lookback_days: 14,
      });

      const perp = await executeSkillWithFallback(
        "perp_contract_analysis",
        perpParams,
        onProgress
      );

      await onProgress({
        percent: basePercent + 10,
        stage: `$${symbol} Orderbook`,
        message: `🧱 Reading $${symbol} bid and ask pressure...`,
      });

      const orderbookParams = buildCMCParams(symbol, venue);

      const orderbook = await executeSkillWithFallback(
        "review_perp_orderbook_pressure",
        orderbookParams,
        onProgress
      );

      await onProgress({
        percent: basePercent + 13,
        stage: `$${symbol} Trend Alignment`,
        message: `🕒 Checking $${symbol} 1h / 4h / 1d trend alignment...`,
      });

      const mtfParams = buildCMCParams(symbol, venue, {
        token_id_or_symbol: symbol,
        timeframes: ["1h", "4h", "1d"],
      });

      const mtf = await executeSkillWithFallback(
        "analyze_multi_timeframe_trend_alignment",
        mtfParams,
        onProgress
      );

      const result = classifyCandidate(symbol, {
        accumulation,
        perp,
        orderbook,
        mtf,
      });

      results.push(result);
    } catch (error) {
      console.error(`Failed to analyze ${symbol}:`, error.message);

      errors.push({
        symbol,
        reason: error.message,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  await onProgress({
    percent: 95,
    stage: "Market Classification",
    message: "⚡ Classifying long, short, watchlist and neutral setups...",
  });

  return {
    longs: results.filter((result) => result.category === "long"),
    shorts: results.filter((result) => result.category === "short"),
    watchlist: results.filter((result) => result.category === "watchlist"),
    neutral: results.filter((result) => result.category === "neutral"),
    errors,
  };
}

/**
 * Analyze single asset with live CMC
 */
async function analyzeAsset(symbol, venue = "Binance", onProgress = async () => {}) {
  symbol = normalizeSymbol(symbol);

  await onProgress({
    percent: 15,
    stage: `$${symbol} Early Structure`,
    message: `🧠 Screening $${symbol} accumulation structure...`,
  });

  const accumParams = buildCMCParams(symbol, venue, {
    lookback_days: 14,
  });

  const accumulation = await executeSkillWithFallback(
    "detect_accumulation_breakout_transition",
    accumParams,
    onProgress
  );

  await onProgress({
    percent: 40,
    stage: `$${symbol} Perp Structure`,
    message: `📊 Reading $${symbol} OI, funding, CVD and liquidations...`,
  });

  const perpParams = buildCMCParams(symbol, venue, {
    timeframe: "4h",
    liq_range: "3d",
    lookback_days: 14,
  });

  const perp = await executeSkillWithFallback(
    "perp_contract_analysis",
    perpParams,
    onProgress
  );

  await onProgress({
    percent: 65,
    stage: `$${symbol} Orderbook`,
    message: `🧱 Checking $${symbol} bid and ask pressure...`,
  });

  const orderbookParams = buildCMCParams(symbol, venue);

  const orderbook = await executeSkillWithFallback(
    "review_perp_orderbook_pressure",
    orderbookParams,
    onProgress
  );

  await onProgress({
    percent: 85,
    stage: `$${symbol} Trend Alignment`,
    message: `🕒 Checking $${symbol} 1h / 4h / 1d trend...`,
  });

  const mtfParams = buildCMCParams(symbol, venue, {
    token_id_or_symbol: symbol,
    timeframes: ["1h", "4h", "1d"],
  });

  const mtf = await executeSkillWithFallback(
    "analyze_multi_timeframe_trend_alignment",
    mtfParams,
    onProgress
  );

  return classifyCandidate(symbol, {
    accumulation,
    perp,
    orderbook,
    mtf,
  });
}

// Export v2 API
module.exports = {
  runMarketScan,
  analyzeAsset,
  normalizeSymbol,
  executeSkillWithFallback,
  getCachedResult,
  ResultCache: resultCache,
};