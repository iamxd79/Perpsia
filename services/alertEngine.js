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
        reason: current.isActionable
          ? "New actionable signal detected."
          : "New directional candidate detected; confirmation is still required.",
        alertType: current.isActionable
          ? "new_actionable_signal"
          : "new_directional_candidate",
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

function friendlyMarketState(signal = {}) {
  const category = String(signal.category || "").toLowerCase();
  if (category === "long") return "Developing bullish setup";
  if (category === "short") return "Developing bearish setup";
  if (category === "watchlist") return "Watchlist candidate";
  return "Developing market conditions";
}

function friendlyCategory(category) {
  const value = String(category || "").toLowerCase();
  if (value === "long") return "LONG candidate";
  if (value === "short") return "SHORT candidate";
  if (value === "watchlist") return "WATCHLIST";
  return "MONITORING";
}

function friendlyDirection(direction) {
  const value = String(direction || "").toLowerCase();
  if (value.includes("bull")) return "Bullish bias";
  if (value.includes("bear")) return "Bearish bias";
  return "Market context";
}

function friendlyAlertType(alertType) {
  return {
    direction_flip: "Market bias update",
    category_upgrade: "Setup development",
    new_directional_candidate: "New directional candidate",
    new_actionable_signal: "Actionable signal",
    new_watchlist_signal: "New watchlist candidate",
    score_jump: "Score improvement",
    lifecycle_change: "Setup lifecycle update",
    invalidation: "Setup conditions changed",
  }[alertType] || "Market update";
}

function friendlyVerdict(signal = {}) {
  if (signal.isActionable) return "Actionable setup detected. Review the risk plan before execution.";
  if (signal.category === "long" || signal.category === "short") return "Directional bias detected. Waiting for stronger confirmation before an active setup.";
  if (signal.category === "watchlist") return "Watchlist candidate. Momentum or confirmation is still developing.";
  return "Market context is developing. No active setup is being issued yet.";
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

Update: ${friendlyAlertType(alertDecision.alertType)}
Reason: ${alertDecision.reason}

Market State: ${friendlyMarketState(signal)}
Category: ${friendlyCategory(signal.category)}
Direction: ${friendlyDirection(signal.direction)}
Score: ${signal.score}/100

Price: ${signal.price}
Price Change: ${signal.priceChange}%
OI Change: ${signal.oiChange}%
Funding: ${signal.funding}%

Why:
${signal.reasons.slice(0, 4).map((r) => `• ${r}`).join("\n")}

Verdict:
${friendlyVerdict(signal)}
`;
}

module.exports = {
  shouldSendAlert,
  formatSmartAlert,
};