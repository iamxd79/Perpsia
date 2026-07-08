function calculateRiskPlan(signal, settings) {
  const capital = Number(settings.capital);
  const riskPercent = Number(settings.riskPercent);
  const maxLeverage = Number(settings.maxLeverage);

  if (!signal.isActionable) {
    return {
      enabled: false,
      reason: "Risk plan only applies to actionable long/short setups.",
    };
  }

  const entryText = signal.entry || "";
  const entryParts = entryText
    .split("-")
    .map((x) => Number(x.trim()))
    .filter(Number.isFinite);

  if (!entryParts.length || !signal.stop || signal.stop === "N/A") {
    return {
      enabled: false,
      reason: "Missing valid entry or invalidation level.",
    };
  }

  const entry =
    entryParts.reduce((sum, value) => sum + value, 0) / entryParts.length;

  const stop = Number(signal.stop);

  if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry === stop) {
    return {
      enabled: false,
      reason: "Invalid entry/stop structure.",
    };
  }

  const maxLossUsd = capital * (riskPercent / 100);
  const stopDistancePercent = Math.abs((entry - stop) / entry) * 100;

  const notional = maxLossUsd / (stopDistancePercent / 100);
  const marginAtMaxLeverage = notional / maxLeverage;

  return {
    enabled: true,
    capital,
    riskPercent,
    maxLeverage,
    maxLossUsd,
    entry,
    stop,
    stopDistancePercent,
    suggestedNotional: notional,
    requiredMargin: marginAtMaxLeverage,
  };
}

function formatRiskPlan(plan) {
  if (!plan?.enabled) {
    return `
🛡️ RISK ENGINE

No position size calculated.

Reason:
${plan?.reason || "No actionable setup."}
`;
  }

  return `
🛡️ RISK ENGINE

Capital: $${plan.capital}
Risk per trade: ${plan.riskPercent}%
Max loss: $${plan.maxLossUsd.toFixed(2)}

Entry used: ${plan.entry.toFixed(6)}
Invalidation: ${plan.stop.toFixed(6)}
Stop distance: ${plan.stopDistancePercent.toFixed(2)}%

Suggested notional: $${plan.suggestedNotional.toFixed(2)}
Required margin at ${plan.maxLeverage}x: $${plan.requiredMargin.toFixed(2)}

Rule:
If invalidation hits, estimated loss stays near your risk limit.
`;
}

module.exports = {
  calculateRiskPlan,
  formatRiskPlan,
};