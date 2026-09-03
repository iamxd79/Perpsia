// ==========================================
// PERPSIA MOMENTUM DIVERGENCE ANALYSIS
// ==========================================

function toFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (value === null || value === undefined || value === "") return null;

  const parsed = Number.parseFloat(
    String(value).replace(/,/g, "").replace(/%/g, "").trim()
  );

  return Number.isFinite(parsed) ? parsed : null;
}

function analyzeDivergence(current = {}, previous = null) {
  const priceChange = toFiniteNumber(current.priceChange);
  const oiChange = toFiniteNumber(current.oiChange);
  const fundingState = String(current.evidence?.fundingState || "");
  const previousTypes = new Set(
    Array.isArray(previous?.divergences)
      ? previous.divergences.map((item) => item?.type)
      : []
  );

  const divergences = [];

  if (priceChange !== null && oiChange !== null) {
    if (priceChange > 0 && oiChange < 0) {
      divergences.push({
        type: "PRICE_OI_DIVERGENCE",
        severity: "HIGH",
        message: "Price up but OI declining—weak momentum, likely pullback.",
        scoreAdjust: -15,
      });
    }

    if (Math.abs(priceChange) < 3 && oiChange > 60) {
      divergences.push({
        type: "OI_PRICE_TRAP",
        severity: "MEDIUM",
        message: "OI spiking but price flat = possible trap accumulation.",
        scoreAdjust: -8,
      });
    }
  }

  if (
    priceChange !== null &&
    priceChange > 0 &&
    fundingState === "Negative / Short-Squeeze Fuel"
  ) {
    divergences.push({
      type: "SQUEEZE_DRIVEN",
      severity: "MEDIUM",
      message: "Price is up from short squeeze, not accumulation.",
      scoreAdjust: -10,
    });
  }

  return divergences.map((divergence) => ({
    ...divergence,
    isNew: !previousTypes.has(divergence.type),
  }));
}

module.exports = {
  analyzeDivergence,
  toFiniteNumber,
};
