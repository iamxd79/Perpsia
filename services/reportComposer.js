function formatMemoryChange(change) {
  if (!change) return "";

  if (change.isNew) {
    return `
🧠 MEMORY

First time tracking this asset.
`;
  }

  if (!change.changes.length) {
    return `
🧠 MEMORY

No meaningful change since last analysis.
`;
  }

  return `
🧠 MEMORY

${change.summary}

${change.changes.map((item) => `• ${item}`).join("\n")}
`;
}

function formatLifecycle(lifecycle) {
  if (!lifecycle) return "";

  const stage =
    lifecycle.changed && lifecycle.previousStage
      ? `${lifecycle.previousStage} → ${lifecycle.stage}`
      : lifecycle.stage;

  return `
🧬 LIFECYCLE

${stage}

${lifecycle.reason}
`;
}

function formatActiveReport(signal, lifecycle, decay, counter, memory) {
  return `
${signal.category === "long" ? "🚀" : "🔻"} PERPSIA ACTIVE SIGNAL — $${signal.symbol}

Market State: ${signal.marketState}
Direction: ${signal.direction}
Score: ${signal.score}/100

📊 MARKET SNAPSHOT

Price: ${signal.price}
Price Change: ${signal.priceChange}%
OI Change: ${signal.oiChange}%
Funding: ${signal.funding}%

🎯 TRADE PLAN

Entry: ${signal.entry}
TP1: ${signal.tp1}
TP2: ${signal.tp2}
Invalidation: ${signal.stop}

🧠 WHY THIS MATTERS

${signal.reasons.map((reason) => `• ${reason}`).join("\n")}

⚔️ COUNTER-THESIS

${counter.risks.length
  ? counter.risks.map((risk) => `• ${risk}`).join("\n")
  : "• No major counter-thesis detected."}

${formatLifecycle(lifecycle)}

${decay?.status && decay.status !== "STABLE"
  ? `
📉 SIGNAL DECAY

${decay.status}

${decay.reasons.map((reason) => `• ${reason}`).join("\n")}
`
  : ""}

${formatMemoryChange(memory)}
`;
}

function formatWatchlistReport(signal, lifecycle, counter, memory) {
  return `
👀 PERPSIA WATCHLIST — $${signal.symbol}

Market State: ${signal.marketState}
Direction: ${signal.direction}
Score: ${signal.score}/100

📊 MARKET SNAPSHOT

Price: ${signal.price}
Price Change: ${signal.priceChange}%
OI Change: ${signal.oiChange}%
Funding: ${signal.funding}%

🧠 WHY IT IS ON WATCH

${signal.reasons.map((reason) => `• ${reason}`).join("\n")}

🔍 CONFIRMATION NEEDED

${signal.confirmationNeeded.map((item) => `• ${item}`).join("\n")}

⚔️ WHAT CAN GO WRONG

${counter.risks.length
  ? counter.risks.map((risk) => `• ${risk}`).join("\n")
  : "• No major counter-thesis detected."}

${formatLifecycle(lifecycle)}

${formatMemoryChange(memory)}
`;
}

function formatNeutralReport(signal, lifecycle, counter, memory) {
  return `
⚪ PERPSIA INTELLIGENCE — $${signal.symbol}

Status: NO TRADE
Lifecycle: ${lifecycle?.stage || signal.lifecycleStage || "UNKNOWN"}
Score: ${signal.score}/100

📊 MARKET SNAPSHOT

Price: ${signal.price}
Price Change: ${signal.priceChange}%
OI Change: ${signal.oiChange}%
Funding: ${signal.funding}%

🧠 WHY NO TRADE

${signal.reasons.length
  ? signal.reasons.map((reason) => `• ${reason}`).join("\n")
  : "• No strong directional evidence found."}

⚔️ WHAT WOULD CHANGE THE VIEW?

${signal.confirmationNeeded?.length
  ? signal.confirmationNeeded.map((item) => `• ${item}`).join("\n")
  : "• Fresh confirmation from OI, trend, or orderbook pressure."}

${formatLifecycle(lifecycle)}

${formatMemoryChange(memory)}
`;
}

function formatInsufficientDataReport(signal, lifecycle, memory) {
  return `
⚠️ PERPSIA INTELLIGENCE — $${signal.symbol}

Status: INSUFFICIENT DATA

Perpsia could not extract enough reliable market fields to classify this asset.

Missing one or more:
• Price
• Price change
• OI change
• Funding

${formatLifecycle(lifecycle)}

${formatMemoryChange(memory)}
`;
}

function composeAssetReport({ signal, lifecycle, decay, counter, memory }) {
  if (!signal.hasCoreData) {
    return formatInsufficientDataReport(signal, lifecycle, memory);
  }

  if (signal.isActionable) {
    return formatActiveReport(signal, lifecycle, decay, counter, memory);
  }

  if (signal.category === "watchlist") {
    return formatWatchlistReport(signal, lifecycle, counter, memory);
  }

  return formatNeutralReport(signal, lifecycle, counter, memory);
}

module.exports = {
  composeAssetReport,
};