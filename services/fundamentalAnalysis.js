"use strict";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usable(record) {
  return record && ["ok", "stale", "degraded"].includes(record.status);
}

function buildFundamentalContext(records = []) {
  const available = records.filter(usable);
  const security = available
    .map((record) => ({ record, risk: number(record.securityRisk) }))
    .filter((item) => item.risk !== null);
  const macro = available.filter((record) => record.marketType === "macro");
  const projects = available.filter((record) => record.marketType === "project");
  const dex = available.filter((record) => record.marketType === "spot" && record.metadata?.pairAddress);
  const reasons = [];
  const risks = [];
  const catalysts = [];
  const maxSecurityRisk = security.length ? Math.max(...security.map((item) => item.risk)) : null;

  if (maxSecurityRisk !== null && maxSecurityRisk >= 70) {
    risks.push("Security provider reports elevated token risk.");
  }

  for (const record of macro) {
    const value = number(record.metadata?.fearGreedValue ?? record.metadata?.value);
    if (record.provider === "alternative" && value !== null) {
      reasons.push("Crypto sentiment index observed at " + value + ".");
    }
    if (record.provider === "fred" && value !== null) {
      reasons.push("FRED macro series observed at " + value + ".");
    }
  }

  for (const record of projects) {
    const metadata = record.metadata || {};
    if (metadata.archived) risks.push("The verified project repository is archived.");
    if (metadata.latestCommitAt || metadata.pushedAt) {
      catalysts.push("Verified project activity is available from GitHub.");
    }
  }

  for (const record of dex) {
    const liquidity = number(record.liquidity);
    const volume = number(record.volume);
    if (liquidity !== null) reasons.push("Observed DEX liquidity: " + Math.round(liquidity) + " USD.");
    if (volume !== null) reasons.push("Observed DEX 24h volume: " + Math.round(volume) + " USD.");
  }

  const hasObservedFundamentals = security.length || macro.length || projects.length || dex.length;
  return {
    status: hasObservedFundamentals ? "available" : "unavailable",
    hardRisk: maxSecurityRisk !== null && maxSecurityRisk >= 80,
    maxSecurityRisk,
    providers: [...new Set(available
      .filter((record) => ["security", "macro", "project", "spot"].includes(record.marketType))
      .map((record) => record.provider))],
    reasons,
    risks,
    catalysts,
    methodology: "Fundamental context uses only observed security, macro, project-activity and DEX records; missing fields are not inferred.",
  };
}

module.exports = {
  buildFundamentalContext,
};
