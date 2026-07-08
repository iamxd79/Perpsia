function shouldSendAlert(current, previous) {
  if (!current.hasCoreData) {
    return {
      shouldAlert: false,
      reason: "Insufficient data.",
      alertType: "none",
    };
  }

  if (!previous) {
    if (current.category === "long" || current.category === "short") {
      return {
        shouldAlert: true,
        reason: "New actionable signal detected.",
        alertType: "new_actionable_signal",
      };
    }

    if (current.category === "watchlist" && current.score >= 50) {
      return {
        shouldAlert: true,
        reason: "New strong watchlist setup detected.",
        alertType: "new_watchlist_signal",
      };
    }

    return {
      shouldAlert: false,
      reason: "First scan, but no strong opportunity.",
      alertType: "none",
    };
  }

  const previousScore = Number(previous.score || 0);
  const currentScore = Number(current.score || 0);
  const scoreDiff = currentScore - previousScore;

  if (
    previous.category !== current.category &&
    (current.category === "long" || current.category === "short")
  ) {
    return {
      shouldAlert: true,
      reason: `Setup upgraded from ${previous.category} to ${current.category}.`,
      alertType: "category_upgrade",
    };
  }

  if (
    previous.direction !== current.direction &&
    current.direction !== "Neutral"
  ) {
    return {
      shouldAlert: true,
      reason: `Direction changed from ${previous.direction} to ${current.direction}.`,
      alertType: "direction_flip",
    };
  }

  if (scoreDiff >= 15 && current.score >= 50) {
    return {
      shouldAlert: true,
      reason: `Score improved meaningfully: ${previousScore} → ${currentScore}.`,
      alertType: "score_jump",
    };
  }

  if (
    previous.lifecycle_stage &&
    previous.lifecycle_stage !== current.lifecycleStage &&
    ["CONFIRMED", "ACTIVE", "BUILDING", "INVALIDATED"].includes(
      current.lifecycleStage
    )
  ) {
    return {
      shouldAlert: true,
      reason: `Lifecycle changed: ${previous.lifecycle_stage} → ${current.lifecycleStage}.`,
      alertType: "lifecycle_change",
    };
  }

  if (
    previous.category !== "neutral" &&
    current.category === "neutral"
  ) {
    return {
      shouldAlert: true,
      reason: "Previous setup moved back to neutral/no-trade conditions.",
      alertType: "invalidation",
    };
  }

  return {
    shouldAlert: false,
    reason: "No meaningful alert condition met.",
    alertType: "none",
  };
}

function formatSmartAlert(signal, alertDecision) {
  const icon =
    signal.category === "long"
      ? "🚀"
      : signal.category === "short"
      ? "🔻"
      : signal.category === "watchlist"
      ? "👀"
      : "⚪";

  return `
${icon} PERPSIA SMART ALERT — $${signal.symbol}

Alert Type: ${alertDecision.alertType}
Reason: ${alertDecision.reason}

Market State: ${signal.marketState}
Category: ${signal.category.toUpperCase()}
Direction: ${signal.direction}
Score: ${signal.score}/100

Price: ${signal.price}
Price Change: ${signal.priceChange}%
OI Change: ${signal.oiChange}%
Funding: ${signal.funding}%

Why:
${signal.reasons.slice(0, 4).map((r) => `• ${r}`).join("\n")}

Verdict:
${signal.isActionable
  ? "Actionable setup detected. Use risk profile before execution."
  : "Worth monitoring, but not an active trade yet."}
`;
}

module.exports = {
  shouldSendAlert,
  formatSmartAlert,
};