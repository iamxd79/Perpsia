"use strict";

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function median(values) {
  const numbers = values.map(numeric).filter((value) => value !== null).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function pctDifference(left, right) {
  if (left === null || right === null || right === 0) return null;
  return ((left - right) / right) * 100;
}

function sign(value) {
  const number = numeric(value);
  return number === null || number === 0 ? 0 : number > 0 ? 1 : -1;
}

function buildCrossSourceSignals(records = [], options = {}) {
  const usable = records.filter((record) => (
    record &&
    ["ok", "stale", "degraded"].includes(record.status) &&
    record.freshness?.status !== "missing"
  ));
  const cex = usable.filter((record) => record.marketType === "perpetual");
  const dex = usable.filter((record) => record.marketType === "spot" && record.metadata?.pairAddress);
  const signals = [];
  let scoreAdjustment = 0;

  const funding = cex.map((record) => record.funding).filter((value) => numeric(value) !== null).map(Number);
  if (funding.length >= 2) {
    const fundingRange = Math.max(...funding) - Math.min(...funding);
    if (fundingRange >= 0.0005) {
      const direction = median(funding) < 0 ? "bullish" : "bearish";
      const adjustment = direction === "bullish" ? 4 : -4;
      scoreAdjustment += adjustment;
      signals.push({
        type: "CROSS_EXCHANGE_FUNDING_DIVERGENCE",
        severity: "MEDIUM",
        direction,
        scoreAdjust: adjustment,
        value: fundingRange,
        message: "Funding differs materially across perpetual venues; " + (direction === "bullish"
          ? "negative funding adds squeeze fuel."
          : "positive funding signals crowded longs."),
        providers: cex.filter((record) => record.funding !== null).map((record) => record.provider),
      });
    }
  }

  const oiChanges = cex
    .map((record) => numeric(record.metadata?.openInterestChangePct))
    .filter((value) => value !== null);
  const priceChanges = cex
    .map((record) => numeric(record.priceChange))
    .filter((value) => value !== null);
  const medianPriceChange = median(priceChanges);
  const medianOiChange = median(oiChanges);
  if (medianOiChange !== null && medianPriceChange !== null && oiChanges.length >= 2) {
    if (medianPriceChange > 1 && medianOiChange < -2) {
      scoreAdjustment -= 8;
      signals.push({
        type: "PRICE_OI_DIVERGENCE",
        severity: "HIGH",
        direction: "bearish",
        scoreAdjust: -8,
        message: "Price is rising while cross-exchange open interest is declining.",
      });
    } else if (medianPriceChange < -1 && medianOiChange > 2) {
      scoreAdjustment -= 5;
      signals.push({
        type: "PRICE_OI_DIVERGENCE",
        severity: "HIGH",
        direction: "bearish",
        scoreAdjust: -5,
        message: "Price is falling while cross-exchange open interest is expanding.",
      });
    } else if (medianPriceChange > 1 && medianOiChange > 2) {
      scoreAdjustment += 7;
      signals.push({
        type: "PRICE_OI_CONFIRMATION",
        severity: "MEDIUM",
        direction: "bullish",
        scoreAdjust: 7,
        message: "Price and open interest are expanding together across venues.",
      });
    }
  }

  const bases = cex
    .map((record) => pctDifference(record.perpPrice, record.spotPrice))
    .filter((value) => value !== null);
  const medianBasis = median(bases);
  if (medianBasis !== null && Math.abs(medianBasis) >= 0.5) {
    const adjustment = medianBasis < 0 ? 4 : -4;
    scoreAdjustment += adjustment;
    signals.push({
      type: "SPOT_PERP_DIVERGENCE",
      severity: "MEDIUM",
      direction: adjustment > 0 ? "bullish" : "bearish",
      scoreAdjust: adjustment,
      value: medianBasis,
      message: "Perpetual prices trade at a " + Math.abs(medianBasis).toFixed(2) + "% " + (medianBasis > 0 ? "premium" : "discount") + " to spot.",
    });
  }

  const orderbookImbalances = cex
    .map((record) => numeric(record.orderbook?.imbalance))
    .filter((value) => value !== null);
  const medianImbalance = median(orderbookImbalances);
  if (medianImbalance !== null && Math.abs(medianImbalance) >= 0.15) {
    const adjustment = medianImbalance > 0 ? 5 : -5;
    scoreAdjustment += adjustment;
    signals.push({
      type: "ORDERBOOK_IMBALANCE",
      severity: "MEDIUM",
      direction: adjustment > 0 ? "bullish" : "bearish",
      scoreAdjust: adjustment,
      value: medianImbalance,
      message: "Aggregated top-of-book depth is " + (adjustment > 0 ? "bid-heavy." : "ask-heavy."),
    });
  }

  const cexPrices = cex
    .map((record) => numeric(record.spotPrice || record.price))
    .filter((value) => value !== null);
  const dexPrices = dex.map((record) => numeric(record.price)).filter((value) => value !== null);
  const cexMedian = median(cexPrices);
  const dexMedian = median(dexPrices);
  const cexDexDifference = pctDifference(dexMedian, cexMedian);
  if (cexDexDifference !== null && Math.abs(cexDexDifference) >= 1) {
    const adjustment = cexDexDifference > 0 ? 3 : -3;
    scoreAdjustment += adjustment;
    signals.push({
      type: "CEX_DEX_PRICE_DIVERGENCE",
      severity: "MEDIUM",
      direction: adjustment > 0 ? "bullish" : "bearish",
      scoreAdjust: adjustment,
      value: cexDexDifference,
      message: "DEX price is " + Math.abs(cexDexDifference).toFixed(2) + "% " + (cexDexDifference > 0 ? "above" : "below") + " tracked CEX spot.",
    });
  }

  const acceleratingDex = dex.filter((record) => (
    numeric(record.metadata?.volumeAcceleration) !== null &&
    numeric(record.metadata.volumeAcceleration) >= 1.5
  ));
  if (acceleratingDex.length) {
    scoreAdjustment += 5;
    signals.push({
      type: "DEX_VOLUME_ACCELERATION",
      severity: "MEDIUM",
      direction: "bullish",
      scoreAdjust: 5,
      message: "DEX volume is accelerating relative to its 24-hour run rate.",
      providers: acceleratingDex.map((record) => record.provider),
    });
  }

  const liquidDeltas = usable
    .map((record) => numeric(record.metadata?.liquidityChangePct))
    .filter((value) => value !== null);
  const medianLiquidityDelta = median(liquidDeltas);
  if (medianLiquidityDelta !== null && Math.abs(medianLiquidityDelta) >= 10) {
    const adjustment = medianLiquidityDelta > 0 ? 4 : -6;
    scoreAdjustment += adjustment;
    signals.push({
      type: "LIQUIDITY_CHANGE",
      severity: "MEDIUM",
      direction: adjustment > 0 ? "bullish" : "bearish",
      scoreAdjust: adjustment,
      value: medianLiquidityDelta,
      message: "Tracked liquidity is " + (medianLiquidityDelta > 0 ? "growing." : "declining."),
    });
  }

  const sentiment = usable.find((record) => record.provider === "alternative");
  const fearGreed = numeric(sentiment?.metadata?.fearGreedValue);
  if (fearGreed !== null) {
    if (fearGreed <= 20) {
      scoreAdjustment += 2;
      signals.push({
        type: "MACRO_FEAR_REGIME",
        severity: "LOW",
        direction: "bullish",
        scoreAdjust: 2,
        value: fearGreed,
        message: "Crypto sentiment is in extreme fear; risk appetite is defensive.",
      });
    } else if (fearGreed >= 80) {
      scoreAdjustment -= 3;
      signals.push({
        type: "MACRO_GREED_REGIME",
        severity: "LOW",
        direction: "bearish",
        scoreAdjust: -3,
        value: fearGreed,
        message: "Crypto sentiment is in extreme greed; late-cycle risk is elevated.",
      });
    }
  }

  const securityRisks = usable
    .map((record) => numeric(record.securityRisk))
    .filter((value) => value !== null);
  const maxSecurityRisk = securityRisks.length ? Math.max(...securityRisks) : null;
  if (maxSecurityRisk !== null && maxSecurityRisk >= 80) {
    scoreAdjustment -= 30;
    signals.push({
      type: "TOKEN_SECURITY_RISK",
      severity: "CRITICAL",
      direction: "bearish",
      scoreAdjust: -30,
      hardRisk: true,
      value: maxSecurityRisk,
      message: "A security provider reports critical token risk; no actionable setup should be issued.",
    });
  }

  const directions = priceChanges.map(sign).filter(Boolean);
  const bullish = directions.filter((value) => value > 0).length;
  const bearish = directions.filter((value) => value < 0).length;
  const agreement = bullish === 0 && bearish === 0
    ? "unknown"
    : bullish === 0 || bearish === 0
      ? "agreement"
      : "disagreement";
  if (agreement === "agreement" && directions.length >= 2) {
    const adjustment = bullish > 0 ? 3 : -3;
    scoreAdjustment += adjustment;
    signals.push({
      type: "SOURCE_AGREEMENT",
      severity: "LOW",
      direction: adjustment > 0 ? "bullish" : "bearish",
      scoreAdjust: adjustment,
      message: "Independent perpetual venues agree on the current price direction.",
    });
  } else if (agreement === "disagreement") {
    scoreAdjustment -= 2;
    signals.push({
      type: "SOURCE_DISAGREEMENT",
      severity: "MEDIUM",
      direction: "neutral",
      scoreAdjust: -2,
      message: "Independent perpetual venues disagree on price direction; confidence is reduced.",
    });
  }

  return {
    scoreAdjustment: Math.max(-40, Math.min(40, scoreAdjustment)),
    signals,
    sourceAgreement: agreement,
    providersUsed: [...new Set(usable.map((record) => record.provider))],
    observations: {
      cexCount: cex.length,
      dexCount: dex.length,
      fundingRange: funding.length >= 2 ? Math.max(...funding) - Math.min(...funding) : null,
      medianOpenInterestChangePct: medianOiChange,
      medianOrderbookImbalance: medianImbalance,
      medianSpotPerpBasisPct: medianBasis,
      cexDexPriceDifferencePct: cexDexDifference,
      fearGreed,
      maxSecurityRisk,
    },
    options,
  };
}

module.exports = {
  buildCrossSourceSignals,
  median,
  pctDifference,
};
