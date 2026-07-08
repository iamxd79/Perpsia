// ==========================================
// PERPSIA OPPORTUNITY LIFECYCLE ENGINE
// ==========================================

function getLifecycleStage(current, previous) {
  // ==========================================
  // CORE DATA CHECK
  // ==========================================

  if (!current.hasCoreData) {
    return {
      stage: "INSUFFICIENT_DATA",
      previousStage: previous?.lifecycle_stage || null,
      changed:
        previous?.lifecycle_stage !== "INSUFFICIENT_DATA",
      reason: "Core market data is missing.",
      scoreDiff: 0,
    };
  }

  // ==========================================
  // FIRST RECORDED ANALYSIS
  // ==========================================

  if (!previous) {
    if (
      current.category === "long" ||
      current.category === "short"
    ) {
      return {
        stage: "CONFIRMED",
        previousStage: null,
        changed: true,
        reason:
          "First recorded analysis already meets confirmed signal conditions.",
        scoreDiff: 0,
      };
    }

    if (current.category === "watchlist") {
      return {
        stage: "DISCOVERED",
        previousStage: null,
        changed: true,
        reason:
          "A new potential opportunity has been discovered.",
        scoreDiff: 0,
      };
    }

    return {
      stage: "NEUTRAL",
      previousStage: null,
      changed: true,
      reason:
        "No actionable opportunity detected on the first recorded analysis.",
      scoreDiff: 0,
    };
  }

  // ==========================================
  // PREVIOUS STATE
  // ==========================================

  const previousStage =
    previous.lifecycle_stage || "UNKNOWN";

  const previousScore =
    Number(previous.score || 0);

  const currentScore =
    Number(current.score || 0);

  const scoreDiff =
    currentScore - previousScore;

  let stage = previousStage;

  let reason =
    "No meaningful lifecycle change detected.";

  // ==========================================
  // NEUTRAL CURRENT CATEGORY
  // ==========================================

  if (current.category === "neutral") {
    // Already invalidated
    if (previousStage === "INVALIDATED") {
      stage = "INVALIDATED";

      reason =
        "Setup remains invalidated. No new opportunity has developed.";
    }

    // Already neutral
    else if (previousStage === "NEUTRAL") {
      stage = "NEUTRAL";

      reason =
        "Market conditions remain neutral with no actionable setup.";
    }

    // Legacy database record
    else if (
      previousStage === "UNKNOWN" ||
      !previous.lifecycle_stage
    ) {
      stage = "NEUTRAL";

      reason =
        "No active lifecycle history exists and current conditions remain neutral.";
    }

    // Real invalidation
    else {
      stage = "INVALIDATED";

      reason =
        "The previous opportunity lost confirmation and moved back to neutral/no-trade conditions.";
    }
  }

  // ==========================================
  // WATCHLIST CURRENT CATEGORY
  // ==========================================

  else if (current.category === "watchlist") {
    // New opportunity after neutral/invalidation
    if (
      previousStage === "NEUTRAL" ||
      previousStage === "INVALIDATED" ||
      previousStage === "UNKNOWN"
    ) {
      stage = "DISCOVERED";

      reason =
        "A new potential opportunity has emerged and requires monitoring.";
    }

    // Strong improvement
    else if (scoreDiff >= 15) {
      stage = "BUILDING";

      reason =
        `Setup strength improved meaningfully with a score increase of ${scoreDiff} points.`;
    }

    // Strong deterioration
    else if (scoreDiff <= -15) {
      stage = "WEAKENING";

      reason =
        `Setup strength deteriorated with a score decline of ${Math.abs(
          scoreDiff
        )} points.`;
    }

    // Already building
    else if (previousStage === "BUILDING") {
      stage = "BUILDING";

      reason =
        "The opportunity continues developing but has not reached confirmation yet.";
    }

    // Already weakening
    else if (previousStage === "WEAKENING") {
      stage = "WEAKENING";

      reason =
        "The opportunity remains weaker and still requires renewed confirmation.";
    }

    // Standard watch state
    else {
      stage = "WATCHING";

      reason =
        "The opportunity remains under observation without a major lifecycle change.";
    }
  }

  // ==========================================
  // CONFIRMED LONG / SHORT CATEGORY
  // ==========================================

  else if (
    current.category === "long" ||
    current.category === "short"
  ) {
    // New confirmation
    if (
      previousStage !== "CONFIRMED" &&
      previousStage !== "ACTIVE"
    ) {
      stage = "CONFIRMED";

      reason =
        "Market evidence strengthened enough to confirm the opportunity.";
    }

    // Confirmed becomes active
    else if (previousStage === "CONFIRMED") {
      stage = "ACTIVE";

      reason =
        "The confirmed opportunity remains valid and has progressed to active monitoring.";
    }

    // Remains active
    else {
      stage = "ACTIVE";

      reason =
        "The opportunity remains active with confirmation still intact.";
    }
  }

  // ==========================================
  // TRANSITION DETECTION
  // ==========================================

  const changed =
    stage !== previousStage &&
    previousStage !== "UNKNOWN";

  return {
    stage,
    previousStage,
    changed,
    reason,
    scoreDiff,
  };
}


// ==========================================
// FORMAT TELEGRAM OUTPUT
// ==========================================

function formatLifecycleUpdate(lifecycle) {
  if (!lifecycle) {
    return "";
  }

  let stageDisplay;

  // Real transition
  if (
    lifecycle.changed &&
    lifecycle.previousStage
  ) {
    stageDisplay =
      `${lifecycle.previousStage} → ${lifecycle.stage}`;
  }

  // Stable state
  else {
    stageDisplay = lifecycle.stage;
  }

  return `
🧬 LIFECYCLE

Stage: ${stageDisplay}

${lifecycle.reason}
`;
}


// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getLifecycleStage,
  formatLifecycleUpdate,
};