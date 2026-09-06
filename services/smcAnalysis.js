"use strict";

// Deterministic Smart Money Concepts-style price-structure analysis.
// These are observable price/volume patterns, not proof of institutional intent.

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, finite(value) ?? 0));
}

function normalizeCandles(input) {
  return (Array.isArray(input) ? input : [])
    .map((candle) => {
      const timestamp = finite(candle?.timestamp ?? candle?.time ?? candle?.[0]);
      const open = finite(candle?.open ?? candle?.[1]);
      const high = finite(candle?.high ?? candle?.[2]);
      const low = finite(candle?.low ?? candle?.[3]);
      const close = finite(candle?.close ?? candle?.[4]);
      const volume = finite(candle?.volume ?? candle?.[5]);
      if ([timestamp, open, high, low, close].some((value) => value === null)) return null;
      if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) return null;
      return { timestamp, open, high, low, close, volume: volume ?? 0 };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function trueRange(candle, previousClose = null) {
  if (!candle) return null;
  const previous = finite(previousClose);
  return Math.max(
    candle.high - candle.low,
    previous === null ? 0 : Math.abs(candle.high - previous),
    previous === null ? 0 : Math.abs(candle.low - previous),
  );
}

function atr(candles, period = 14, endIndex = candles.length - 1) {
  const start = Math.max(0, endIndex - period + 1);
  const ranges = [];
  for (let index = start; index <= endIndex; index += 1) {
    ranges.push(trueRange(candles[index], candles[index - 1]?.close));
  }
  const values = ranges.filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function averageVolume(candles, period = 20, endIndex = candles.length - 1) {
  const start = Math.max(0, endIndex - period + 1);
  const values = candles.slice(start, endIndex + 1).map((candle) => finite(candle.volume)).filter((value) => value !== null && value > 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function isPivotHigh(candles, index, left, right) {
  const value = candles[index]?.high;
  if (value === undefined) return false;
  for (let offset = 1; offset <= left; offset += 1) {
    if (candles[index - offset]?.high >= value) return false;
  }
  for (let offset = 1; offset <= right; offset += 1) {
    if (candles[index + offset]?.high >= value) return false;
  }
  return true;
}

function isPivotLow(candles, index, left, right) {
  const value = candles[index]?.low;
  if (value === undefined) return false;
  for (let offset = 1; offset <= left; offset += 1) {
    if (candles[index - offset]?.low <= value) return false;
  }
  for (let offset = 1; offset <= right; offset += 1) {
    if (candles[index + offset]?.low <= value) return false;
  }
  return true;
}

function findSwings(candles, options = {}) {
  const left = Math.max(1, Number(options.left || 2));
  const right = Math.max(1, Number(options.right || 2));
  const highs = [];
  const lows = [];
  for (let index = left; index < candles.length - right; index += 1) {
    if (isPivotHigh(candles, index, left, right)) highs.push({ index, price: candles[index].high });
    if (isPivotLow(candles, index, left, right)) lows.push({ index, price: candles[index].low });
  }
  return { highs, lows, left, right };
}

function structureFromSwings(swings) {
  const highs = swings.highs.slice(-3);
  const lows = swings.lows.slice(-3);
  const lastHigh = highs.at(-1);
  const previousHigh = highs.at(-2);
  const lastLow = lows.at(-1);
  const previousLow = lows.at(-2);

  const bullish = Boolean(lastHigh && previousHigh && lastLow && previousLow &&
    lastHigh.price > previousHigh.price && lastLow.price > previousLow.price);
  const bearish = Boolean(lastHigh && previousHigh && lastLow && previousLow &&
    lastHigh.price < previousHigh.price && lastLow.price < previousLow.price);

  return {
    direction: bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL",
    label: bullish ? "HH_HL" : bearish ? "LH_LL" : "MIXED",
    highs,
    lows,
  };
}

function detectBreaks(candles, swings, structure) {
  const lastIndex = candles.length - 1;
  const last = candles[lastIndex];
  const priorHigh = swings.highs.filter((swing) => swing.index < lastIndex).at(-1);
  const priorLow = swings.lows.filter((swing) => swing.index < lastIndex).at(-1);
  const events = [];

  if (priorHigh && last.close > priorHigh.price) {
    events.push({
      type: structure.direction === "BEARISH" ? "CHOCH" : "BOS",
      direction: "BULLISH",
      level: priorHigh.price,
      index: lastIndex,
      message: (structure.direction === "BEARISH" ? "Bullish CHoCH" : "Bullish BOS") + " above " + priorHigh.price,
    });
  }
  if (priorLow && last.close < priorLow.price) {
    events.push({
      type: structure.direction === "BULLISH" ? "CHOCH" : "BOS",
      direction: "BEARISH",
      level: priorLow.price,
      index: lastIndex,
      message: (structure.direction === "BULLISH" ? "Bearish CHoCH" : "Bearish BOS") + " below " + priorLow.price,
    });
  }

  return events;
}

function detectSweeps(candles, swings) {
  const lastIndex = candles.length - 1;
  const last = candles[lastIndex];
  const priorHigh = swings.highs.filter((swing) => swing.index < lastIndex).at(-1);
  const priorLow = swings.lows.filter((swing) => swing.index < lastIndex).at(-1);
  const events = [];

  if (priorLow && last.low < priorLow.price && last.close >= priorLow.price) {
    events.push({ type: "SELL_SIDE_LIQUIDITY_SWEEP", direction: "BULLISH", level: priorLow.price, index: lastIndex });
  }
  if (priorHigh && last.high > priorHigh.price && last.close <= priorHigh.price) {
    events.push({ type: "BUY_SIDE_LIQUIDITY_SWEEP", direction: "BEARISH", level: priorHigh.price, index: lastIndex });
  }
  return events;
}

function detectEqualLevels(swings, candles, tolerancePercent = 0.15) {
  const price = candles.at(-1)?.close || 0;
  const tolerance = Math.max(price * (tolerancePercent / 100), atr(candles) * 0.25 || 0);
  const equalHighs = [];
  const equalLows = [];
  const highs = swings.highs.slice(-6);
  const lows = swings.lows.slice(-6);

  for (let index = 1; index < highs.length; index += 1) {
    if (Math.abs(highs[index].price - highs[index - 1].price) <= tolerance) {
      equalHighs.push({ level: (highs[index].price + highs[index - 1].price) / 2 });
    }
  }
  for (let index = 1; index < lows.length; index += 1) {
    if (Math.abs(lows[index].price - lows[index - 1].price) <= tolerance) {
      equalLows.push({ level: (lows[index].price + lows[index - 1].price) / 2 });
    }
  }
  return { equalHighs, equalLows, tolerance };
}

function detectFairValueGaps(candles, lookback = 40) {
  const start = Math.max(2, candles.length - lookback);
  const gaps = [];
  for (let index = start; index < candles.length; index += 1) {
    const first = candles[index - 2];
    const current = candles[index];
    if (first.high < current.low) {
      gaps.push({ type: "BULLISH_FVG", direction: "BULLISH", low: first.high, high: current.low, index });
    }
    if (first.low > current.high) {
      gaps.push({ type: "BEARISH_FVG", direction: "BEARISH", low: current.high, high: first.low, index });
    }
  }

  const price = candles.at(-1)?.close;
  return gaps.map((gap) => ({
    ...gap,
    filled: price === undefined
      ? null
      : gap.direction === "BULLISH" ? price <= gap.low : price >= gap.high,
  }));
}

function detectOrderBlock(candles, breaks) {
  const event = breaks.at(-1);
  if (!event) return null;
  for (let index = event.index - 1; index >= Math.max(0, event.index - 8); index -= 1) {
    const candle = candles[index];
    const bearishCandle = candle.close < candle.open;
    const bullishCandle = candle.close > candle.open;
    if ((event.direction === "BULLISH" && bearishCandle) || (event.direction === "BEARISH" && bullishCandle)) {
      return {
        type: event.direction === "BULLISH" ? "BULLISH_ORDER_BLOCK" : "BEARISH_ORDER_BLOCK",
        direction: event.direction,
        low: event.direction === "BULLISH" ? candle.low : Math.min(candle.open, candle.close),
        high: event.direction === "BULLISH" ? Math.max(candle.open, candle.close) : candle.high,
        index,
        breakType: event.type,
      };
    }
  }
  return null;
}

function detectDisplacement(candles) {
  const index = candles.length - 1;
  const candle = candles[index];
  const currentAtr = atr(candles, 14, index - 1);
  const average = averageVolume(candles, 20, index - 1);
  if (!candle || !currentAtr || currentAtr <= 0) return null;
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  const volumeRatio = average && average > 0 ? candle.volume / average : null;
  if (body < currentAtr * 1.5 || range < currentAtr * 1.2 || (volumeRatio !== null && volumeRatio < 1.2)) return null;
  return {
    direction: candle.close > candle.open ? "BULLISH" : "BEARISH",
    bodyAtr: body / currentAtr,
    rangeAtr: range / currentAtr,
    volumeRatio,
  };
}

function premiumDiscount(candles, lookback = 50) {
  const window = candles.slice(-lookback);
  const high = Math.max(...window.map((candle) => candle.high));
  const low = Math.min(...window.map((candle) => candle.low));
  const price = candles.at(-1)?.close;
  if (![high, low, price].every(Number.isFinite) || high <= low) return null;
  const midpoint = (high + low) / 2;
  return {
    high,
    low,
    midpoint,
    price,
    zone: price < midpoint ? "DISCOUNT" : price > midpoint ? "PREMIUM" : "EQUILIBRIUM",
    positionPercent: ((price - low) / (high - low)) * 100,
  };
}

function scoreEvidence({ structure, breaks, sweeps, orderBlock, gaps, displacement, range }) {
  const bullish = [];
  const bearish = [];
  if (structure.direction === "BULLISH") bullish.push({ type: "MARKET_STRUCTURE", weight: 2, message: "Higher highs and higher lows are present." });
  if (structure.direction === "BEARISH") bearish.push({ type: "MARKET_STRUCTURE", weight: 2, message: "Lower highs and lower lows are present." });

  for (const event of breaks) (event.direction === "BULLISH" ? bullish : bearish).push({ type: event.type, weight: 3, message: event.message });
  for (const sweep of sweeps) (sweep.direction === "BULLISH" ? bullish : bearish).push({ type: sweep.type, weight: 3, message: (sweep.direction === "BULLISH" ? "Sell-side" : "Buy-side") + " liquidity sweep detected." });
  if (orderBlock) (orderBlock.direction === "BULLISH" ? bullish : bearish).push({ type: "ORDER_BLOCK", weight: 2, message: orderBlock.type.replaceAll("_", " ") + " identified." });

  const openGap = gaps.filter((gap) => !gap.filled).at(-1);
  if (openGap) (openGap.direction === "BULLISH" ? bullish : bearish).push({ type: "FAIR_VALUE_GAP", weight: 1, message: openGap.type.replaceAll("_", " ") + " remains open." });
  if (displacement) (displacement.direction === "BULLISH" ? bullish : bearish).push({ type: "DISPLACEMENT", weight: 2, message: "Displacement candle confirms directional intent." });
  if (range?.zone === "DISCOUNT") bullish.push({ type: "DISCOUNT", weight: 1, message: "Price is in the discount half of the observed range." });
  if (range?.zone === "PREMIUM") bearish.push({ type: "PREMIUM", weight: 1, message: "Price is in the premium half of the observed range." });

  const bullishScore = bullish.reduce((sum, item) => sum + item.weight, 0);
  const bearishScore = bearish.reduce((sum, item) => sum + item.weight, 0);
  const bias = bullishScore - bearishScore;
  return {
    bullish,
    bearish,
    bullishScore,
    bearishScore,
    bias,
    direction: bias >= 3 ? "BULLISH" : bias <= -3 ? "BEARISH" : "NEUTRAL",
  };
}

function analyzeSMC(input, options = {}) {
  const candles = normalizeCandles(input);
  const minimumCandles = Math.max(20, Number(options.minimumCandles || 40));
  if (candles.length < minimumCandles) {
    return {
      status: "unavailable",
      reason: "insufficient_ohlcv",
      candleCount: candles.length,
      direction: "NEUTRAL",
      scoreAdjustment: 0,
      confidence: 0,
    };
  }

  const swings = findSwings(candles, options);
  const structure = structureFromSwings(swings);
  const breaks = detectBreaks(candles, swings, structure);
  const sweeps = detectSweeps(candles, swings);
  const equalLevels = detectEqualLevels(swings, candles, options.equalLevelTolerancePercent || 0.15);
  const gaps = detectFairValueGaps(candles, options.fvgLookback || 40);
  const orderBlock = detectOrderBlock(candles, breaks);
  const displacement = detectDisplacement(candles);
  const range = premiumDiscount(candles, options.rangeLookback || 50);
  const scored = scoreEvidence({ structure, breaks, sweeps, orderBlock, gaps, displacement, range });
  const evidence = scored[scored.direction === "BULLISH" ? "bullish" : scored.direction === "BEARISH" ? "bearish" : "bullish"];
  const lastSwingLow = swings.lows.at(-1)?.price ?? null;
  const lastSwingHigh = swings.highs.at(-1)?.price ?? null;
  const invalidation = scored.direction === "BULLISH"
    ? orderBlock?.low ?? lastSwingLow
    : scored.direction === "BEARISH"
      ? orderBlock?.high ?? lastSwingHigh
      : null;

  return {
    status: "available",
    methodology: "Deterministic OHLCV price-structure analysis; SMC labels are pattern descriptions, not proof of institutional intent.",
    candleCount: candles.length,
    direction: scored.direction,
    biasScore: scored.bias,
    scoreAdjustment: clamp(Math.round(scored.bias * 1.5), -12, 12),
    confidence: Number(Math.min(1, Math.abs(scored.bias) / 12).toFixed(4)),
    structure,
    breaks,
    sweeps,
    equalLevels,
    fairValueGaps: gaps,
    orderBlock,
    displacement,
    premiumDiscount: range,
    invalidation: invalidation === null ? null : {
      price: invalidation,
      reason: scored.direction === "BULLISH" ? "Close below the bullish structure zone." : "Close above the bearish structure zone.",
    },
    evidence: evidence.map((item) => item.message),
  };
}

module.exports = {
  analyzeSMC,
  atr,
  findSwings,
  normalizeCandles,
};
