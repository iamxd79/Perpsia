// ==========================================
// PERPSIA SIGNAL DECAY ENGINE
// ==========================================

function getSignalDecay(current, previous) {
  if (!previous) {
    return {
      status: "NEW",
      level: "none",
      reasons: ["No previous signal history yet."],
    };
  }

  const reasons = [];

  const previousScore = Number(previous.score || 0);
  const currentScore = Number(current.score || 0);
  const scoreDiff = currentScore - previousScore;

  const previousOi = Number(previous.oi_change);
  const currentOi = Number(current.oiChange);

  const previousPrice = Number(previous.price);
  const currentPrice = Number(current.price);

  if (scoreDiff <= -20) {
    reasons.push(`Score dropped hard: ${previousScore} → ${currentScore}.`);
  } else if (scoreDiff <= -10) {
    reasons.push(`Score is weakening: ${previousScore} → ${currentScore}.`);
  }

  if (
    Number.isFinite(previousOi) &&
    Number.isFinite(currentOi) &&
    previousOi >= 40 &&
    currentOi < 40
  ) {
    reasons.push("OI expansion faded below the active threshold.");
  }

  if (
    Number.isFinite(previousPrice) &&
    Number.isFinite(currentPrice) &&
    previousPrice !== 0
  ) {
    const priceMove = ((currentPrice - previousPrice) / previousPrice) * 100;

    if (current.direction === "Bullish" && priceMove <= -3) {
      reasons.push(`Price moved ${priceMove.toFixed(2)}% against the bullish thesis.`);
    }

    if (current.direction === "Bearish" && priceMove >= 3) {
      reasons.push(`Price moved ${priceMove.toFixed(2)}% against the bearish thesis.`);
    }
  }

  if (
    previous.category &&
    previous.category !== "neutral" &&
    current.category === "neutral"
  ) {
    reasons.push("Setup moved back to neutral/no-trade conditions.");
  }

  if (!reasons.length) {
    return {
      status: "STABLE",
      level: "none",
      reasons: ["No meaningful decay detected."],
    };
  }

  const severe = reasons.some(
    (reason) =>
      reason.includes("dropped hard") ||
      reason.includes("neutral/no-trade")
  );

  return {
    status: severe ? "DECAYING_FAST" : "DECAYING",
    level: severe ? "high" : "medium",
    reasons,
  };
}

function formatSignalDecay(decay) {
  if (!decay) return "";

  if (decay.status === "NEW") {
    return `
📉 SIGNAL DECAY

Status: NEW

${decay.reasons.map((reason) => `• ${reason}`).join("\n")}
`;
  }

  if (decay.status === "STABLE") {
    return `
📉 SIGNAL DECAY

Status: STABLE

${decay.reasons.map((reason) => `• ${reason}`).join("\n")}
`;
  }

  const icon = decay.level === "high" ? "🚨" : "⚠️";

  return `
${icon} SIGNAL DECAY

Status: ${decay.status}

${decay.reasons.map((reason) => `• ${reason}`).join("\n")}
`;
}

module.exports = {
  getSignalDecay,
  formatSignalDecay,
};