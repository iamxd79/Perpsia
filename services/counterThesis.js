function getCounterThesis(signal) {
  const risks = [];
  const invalidationWarnings = [];

  if (!signal.hasCoreData) {
    return {
      status: "NO_ANALYSIS",
      risks: ["Core market data is missing."],
      invalidationWarnings: [],
      finalDecision: "No trade. The agent cannot build a reliable thesis.",
    };
  }

  if (signal.oiChange !== null && signal.oiChange < 40) {
    risks.push("OI expansion is not strong enough yet.");
  }

  if (signal.oiChange !== null && signal.oiChange < 0) {
    risks.push("OI is declining, so fresh positioning is missing.");
  }

  if (signal.direction === "Bullish" && signal.evidence?.mtfTrend !== "Bullish") {
    risks.push("Bullish thesis is not confirmed by multi-timeframe trend.");
  }

  if (signal.direction === "Bearish" && signal.evidence?.mtfTrend !== "Bearish") {
    risks.push("Bearish thesis is not confirmed by multi-timeframe trend.");
  }

  if (signal.direction === "Bullish" && signal.evidence?.orderbook !== "Bullish") {
    risks.push("Buyer support is not strong enough in the orderbook.");
  }

  if (signal.direction === "Bearish" && signal.evidence?.orderbook !== "Bearish") {
    risks.push("Seller pressure is not strong enough in the orderbook.");
  }

  if (signal.funding !== null && signal.funding <= -1) {
    risks.push("Funding is extremely negative, so the setup can be unstable.");
  }

  if (signal.priceChange !== null && Math.abs(signal.priceChange) > 50) {
    risks.push("Price has already moved heavily, increasing reversal/chase risk.");
  }

  if (signal.category === "neutral") {
    risks.push("Current category is neutral, so there is no confirmed opportunity.");
  }

  if (signal.conflicts?.length) {
    risks.push(...signal.conflicts);
  }

  if (signal.direction === "Bullish") {
    invalidationWarnings.push("Fresh OI expansion fails to appear.");
    invalidationWarnings.push("Price loses the downside liquidity zone.");
    invalidationWarnings.push("MTF trend stays bearish or mixed.");
  }

  if (signal.direction === "Bearish") {
    invalidationWarnings.push("Funding remains deeply negative and shorts get squeezed.");
    invalidationWarnings.push("Price reclaims upside liquidity.");
    invalidationWarnings.push("MTF trend turns bullish.");
  }

  let finalDecision = "No trade. Wait for cleaner confirmation.";

  if (signal.isActionable && risks.length <= 2) {
    finalDecision = "Trade candidate, but only with strict invalidation.";
  } else if (signal.category === "watchlist") {
    finalDecision = "Watchlist only. Conditions are interesting but not confirmed.";
  } else if (signal.category === "neutral") {
    finalDecision = "No trade. Current evidence is too weak or too late.";
  }

  return {
    status: risks.length ? "HAS_COUNTER_THESIS" : "CLEAN",
    risks,
    invalidationWarnings,
    finalDecision,
  };
}

function formatCounterThesis(counter) {
  if (!counter) return "";

  return `
⚔️ COUNTER-THESIS

What can go wrong:

${counter.risks.length
  ? counter.risks.map((risk) => `• ${risk}`).join("\n")
  : "• No major counter-thesis detected."}

Invalidation watch:

${counter.invalidationWarnings.length
  ? counter.invalidationWarnings.map((risk) => `• ${risk}`).join("\n")
  : "• No specific invalidation watch available."}

Final decision:

${counter.finalDecision}
`;
}

module.exports = {
  getCounterThesis,
  formatCounterThesis,
};