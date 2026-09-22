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

function noTradeReason(signal = {}) {
  const state = String(signal.marketState || "").toLowerCase();
  if (signal.hasCoreData === false || state.includes("insufficient") || state.includes("data")) {
    return "No trade: market data is incomplete. Wait for a clean, confirmed data set.";
  }
  if (state.includes("security")) {
    return "No trade: security checks blocked this asset.";
  }
  if (state.includes("overextended") || state.includes("chasing")) {
    return "No trade: the move is already extended. Wait for a safer pullback or reset.";
  }
  if (state.includes("squeeze") || state.includes("crowd") || state.includes("unwind")) {
    return "No trade: the directional read conflicts with positioning risk. Keep it on watch.";
  }
  if (signal.lifecycleStage === "INVALIDATED") {
    return "No trade: the previous setup lost confirmation. A new setup must build from fresh evidence.";
  }
  return "No trade: evidence is mixed or below the confirmation threshold. Directional bias can still change.";
}

function friendlyMarketState(signal = {}) {
  const category = String(signal.category || "").toLowerCase();
  const state = String(signal.marketState || "").toLowerCase();
  if (category === "long") return signal.isActionable ? "Active bullish setup" : "Developing bullish setup";
  if (category === "short") return signal.isActionable ? "Active bearish setup" : "Developing bearish setup";
  if (category === "watchlist") return "Watchlist candidate";
  if (state.includes("security")) return "Security review required";
  if (state.includes("overextended") || state.includes("chasing")) return "Overextended move";
  if (signal.hasCoreData === false || state.includes("insufficient")) return "Data quality gap";
  return "Mixed / developing conditions";
}

function friendlyCategory(category, signal = {}) {
  const value = String(category || "").toLowerCase();
  if (value === "long") return signal.isActionable ? "LONG" : "LONG candidate";
  if (value === "short") return signal.isActionable ? "SHORT" : "SHORT candidate";
  if (value === "watchlist") return "WATCHLIST";
  return "NO TRADE";
}

function friendlyDirection(direction, signal = {}) {
  const value = String(direction || "").toLowerCase();
  if (value.includes("bull")) return "Bullish bias";
  if (value.includes("bear")) return "Bearish bias";
  if (signal.evidence?.perpFlow === "Bullish") return "Bullish evidence, not confirmed";
  if (signal.evidence?.perpFlow === "Bearish") return "Bearish evidence, not confirmed";
  return "Mixed / no directional edge";
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
  if (signal.isActionable) return `Opportunity: ${String(signal.category).toUpperCase()}. Review entry, invalidation and risk before execution.`;
  if (signal.category === "long" || signal.category === "short") return `Opportunity: ${String(signal.category).toUpperCase()} candidate. Direction is visible; confirmation is still building.`;
  if (signal.category === "watchlist") return "Opportunity: WATCHLIST. Momentum or confirmation is developing; wait for the trigger.";
  return noTradeReason(signal);
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
Category: ${friendlyCategory(signal.category, signal)}
Direction: ${friendlyDirection(signal.direction, signal)}
Score: ${signal.score}/100

Price: ${signal.price}
Price Change: ${signal.priceChange}%
OI Change: ${signal.oiChange}%
Funding: ${signal.funding}%

Why:
${signal.reasons.slice(0, 4).map((r) => `• ${r}`).join("\n")}

User read:
${friendlyVerdict(signal)}
`;
}

module.exports = {
  shouldSendAlert,
  formatSmartAlert,
};