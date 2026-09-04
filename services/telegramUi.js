"use strict";

const PUBLIC_COMMANDS = [
  { command: "start", description: "Open PerpsIA" },
  { command: "scan", description: "Find current perp setups" },
  { command: "analyze", description: "Analyze one asset" },
  { command: "alpha", description: "Find early momentum" },
  { command: "risk", description: "Set your risk profile" },
  { command: "watchlist", description: "Manage tracked assets" },
  { command: "history", description: "View past analyses" },
  { command: "compare", description: "Compare two assets" },
  { command: "backtest", description: "Test past signals" },
  { command: "performance", description: "View signal results" },
  { command: "status", description: "Check PerpsIA status" },
  { command: "settings", description: "Change preferences" },
  { command: "help", description: "View commands" },
  { command: "about", description: "About PerpsIA" },
];

const WELCOME_MESSAGE = [
  "WELCOME TO PERPSIA",
  "",
  "Find perp setups early, track market changes, and manage risk with live market data.",
  "",
  "Choose what you want to do:",
].join("\n");

const HELP_MESSAGE = [
  "PERPSIA COMMANDS",
  "",
  "Find trades",
  "/scan",
  "/alpha",
  "/analyze",
  "",
  "Research",
  "/compare",
  "/history",
  "/backtest",
  "",
  "Manage",
  "/risk",
  "/watchlist",
  "/settings",
  "",
  "PerpsIA",
  "/performance",
  "/status",
  "/about",
].join("\n");

const ABOUT_MESSAGE = [
  "ABOUT PERPSIA",
  "",
  "PerpsIA is an autonomous perpetual futures market intelligence engine. It combines live market data from multiple sources, scores setups, tracks changes, checks risk, and sends structured trading research.",
  "",
  "Some trading links may be affiliate links.",
].join("\n");

function registerPublicCommands(bot) {
  if (!bot || typeof bot.setMyCommands !== "function") {
    throw new TypeError("A Telegram bot with setMyCommands is required.");
  }
  return bot.setMyCommands(PUBLIC_COMMANDS);
}

function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatHeader(title, context) {
  return [cleanText(title).toUpperCase(), cleanText(context)].filter(Boolean);
}

function emptyState(title, message) {
  return [...formatHeader(title), "", cleanText(message)].join("\n").trim();
}

function cleanText(value, fallback = "") {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && /^(?:n\/?a|unknown|null|undefined)$/i.test(value.trim())) return null;
  const parsed = Number(String(value).replaceAll(",", "").replace(/^\$/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value, maximumFractionDigits = 2) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(number);
}

function formatMoney(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const digits = Math.abs(number) >= 1000 ? 2 : Math.abs(number) >= 1 ? 4 : 8;
  return "$" + formatNumber(number, digits);
}

function formatPercent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return (number > 0 ? "+" : "") + formatNumber(number, 2) + "%";
}

function formatScore(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const outOfTen = number > 10 ? number / 10 : number;
  return formatNumber(outOfTen, 1) + "/10";
}

function formatConfidence(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const percent = number <= 1 ? number * 100 : number;
  return Math.round(Math.max(0, Math.min(100, percent))) + "%";
}

function realLevel(value) {
  if (value === null || value === undefined) return null;
  const text = cleanText(value);
  if (!text || /^(?:n\/?a|unknown|null|undefined)$/i.test(text)) return null;
  if (text.includes("-")) {
    const values = text.split("-").map((part) => formatMoney(part.trim())).filter(Boolean);
    return values.length ? values.join(" – ") : null;
  }
  return formatMoney(text);
}

function startKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Scan Market", callback_data: "scan_market" },
        { text: "Analyze Token", callback_data: "analyze_asset" },
      ],
      [
        { text: "Early Alpha", callback_data: "early_alpha" },
        { text: "Set Risk", callback_data: "set_risk" },
      ],
      [
        { text: "Watchlist", callback_data: "show_watchlist" },
        { text: "More", callback_data: "show_commands" },
      ],
    ],
  };
}

function progressBar(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round(safe / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function friendlyStage(percent, suppliedStage) {
  const stage = String(suppliedStage || "").toLowerCase();
  if (stage.includes("orderbook")) return "Reading order books";
  if (stage.includes("risk") || stage.includes("liquidation") || stage.includes("whale")) return "Checking risk";
  if (stage.includes("liquidity") || stage.includes("dex")) return "Checking liquidity";
  if (stage.includes("correlation") || stage.includes("multi-source")) return "Comparing exchanges";
  if (stage.includes("classification")) return "Scoring setups";
  if (stage.includes("perp")) return "Checking funding and open interest";
  if (stage.includes("trend") || stage.includes("structure")) return "Checking price and volume";
  if (percent < 20) return "Finding active markets";
  if (percent < 40) return "Checking price and volume";
  if (percent < 60) return "Checking funding and open interest";
  if (percent < 72) return "Reading order books";
  if (percent < 84) return "Comparing exchanges";
  if (percent < 90) return "Checking liquidity";
  if (percent < 96) return "Checking risk";
  return "Scoring setups";
}

function formatProgress({ kind = "scan", symbol, venue, percent = 0, stage, current, total } = {}) {
  const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const title = kind === "alpha"
    ? "PERPSIA EARLY ALPHA"
    : kind === "analysis"
      ? "PERPSIA TOKEN ANALYSIS"
      : "PERPSIA LIVE SCAN";
  const context = symbol
    ? cleanText(symbol).toUpperCase() + (venue ? " · " + cleanText(venue) : "")
    : venue
      ? cleanText(venue)
      : "";
  const lines = [...formatHeader(title, context), "", progressBar(safePercent) + " " + safePercent + "%", "", friendlyStage(safePercent, stage)];
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    lines.push("", Math.min(current, total) + " / " + total + " markets analyzed");
  }
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n").trim();
}

function scanCounts(result = {}) {
  const longs = Array.isArray(result.longs) ? result.longs : [];
  const shorts = Array.isArray(result.shorts) ? result.shorts : [];
  const watchlist = Array.isArray(result.watchlist) ? result.watchlist : [];
  const neutral = Array.isArray(result.neutral) ? result.neutral : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return {
    strong: longs.length + shorts.length,
    watchlist: watchlist.length,
    filtered: neutral.length + errors.length,
  };
}

function formatScanSummary(result = {}, options = {}) {
  const counts = scanCounts(result);
  const title = options.mode === "alpha" ? "ALPHA SCAN COMPLETE" : "SCAN COMPLETE";
  const lines = [
    title,
    options.venue ? cleanText(options.venue) : "",
    "",
    counts.strong + " strong setups",
    counts.watchlist + " watchlist",
    counts.filtered + " filtered out",
  ];
  return lines
    .filter((line, index) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}

function scanSummaryKeyboard(venue = "Binance") {
  const safeVenue = cleanText(venue, "Binance").replace(/[^A-Za-z]/g, "") || "Binance";
  return {
    inline_keyboard: [
      [
        { text: "View Top Setups", callback_data: "scan_view:top" },
        { text: "View Watchlist", callback_data: "scan_view:watchlist" },
      ],
      [{ text: "Run Again", callback_data: "scan_again:" + safeVenue }],
    ],
  };
}

function compactReasons(values, limit = 3) {
  return (Array.isArray(values) ? values : [])
    .map((value) => cleanText(typeof value === "string" ? value : value?.message))
    .filter(Boolean)
    .slice(0, limit);
}

function lifecycleLabel(signal, lifecycle) {
  return cleanText(lifecycle?.stage || signal?.lifecycleStage || signal?.category || "MONITORING")
    .toUpperCase()
    .replace(/[^A-Z0-9 /_-]/g, "");
}

function formatSignalCard(signal = {}, options = {}) {
  const symbol = cleanText(signal.symbol, "ASSET").toUpperCase();
  const direction = cleanText(signal.direction || signal.category, "SETUP").toUpperCase();
  const heading = signal.isActionable ? symbol + " — " + (direction.includes("BEAR") || direction.includes("SHORT") ? "SHORT SETUP" : "LONG SETUP") : symbol + " — MARKET WATCH";
  const lines = [heading, ""];
  const facts = [
    ["Score", formatScore(signal.score)],
    ["Confidence", formatConfidence(signal.confidenceScore ?? signal.confidence)],
    ["Status", lifecycleLabel(signal, options.lifecycle)],
    ["Price", formatMoney(signal.price)],
    ["24h", formatPercent(signal.priceChange)],
    ["Funding", formatPercent(signal.funding)],
    ["OI", formatPercent(signal.oiChange)],
  ].filter(([, value]) => value);
  for (const [label, value] of facts) lines.push(label.padEnd(12) + value);

  const levels = [
    ["Entry", realLevel(signal.entry)],
    ["TP1", realLevel(signal.tp1)],
    ["TP2", realLevel(signal.tp2)],
    ["Stop", realLevel(signal.stop)],
  ].filter(([, value]) => value);
  if (levels.length) {
    lines.push("");
    for (const [label, value] of levels) lines.push(label.padEnd(12) + value);
  }

  const reasons = compactReasons(signal.reasons);
  if (reasons.length) lines.push("", "Why PerpsIA likes it", ...reasons.map((reason) => "- " + reason));

  const risks = compactReasons([
    ...(options.counter?.risks || []),
    ...(signal.conflicts || []),
  ], 2);
  if (risks.length) lines.push("", "Risk", ...risks.map((risk) => "- " + risk));

  const changeItems = compactReasons(options.memory?.changes, 2);
  if (changeItems.length) lines.push("", "Changed since last scan", ...changeItems.map((item) => "- " + item));

  if (options.riskPlan?.enabled) {
    const plan = options.riskPlan;
    lines.push(
      "",
      "Risk plan",
      "Max loss    " + formatMoney(plan.maxLossUsd),
      "Notional    " + formatMoney(plan.suggestedNotional),
      "Margin " + formatNumber(plan.maxLeverage, 2) + "x  " + formatMoney(plan.requiredMargin)
    );
  }

  return lines.join("\n").trim();
}

function dexSnapshot(signal = {}) {
  const records = Array.isArray(signal.marketEvidence) ? signal.marketEvidence : [];
  const dex = records.filter((record) => ["dexscreener", "geckoterminal"].includes(String(record?.provider || "").toLowerCase()) && record.status === "ok");
  if (!dex.length) return {};
  const strongest = dex.slice().sort((a, b) => (finiteNumber(b.liquidity) || 0) - (finiteNumber(a.liquidity) || 0))[0];
  const acceleration = dex.map((record) => finiteNumber(record.metadata?.volumeAcceleration)).filter((value) => value !== null).sort((a, b) => b - a)[0];
  const liquidityChange = dex.map((record) => finiteNumber(record.metadata?.liquidityChangePct)).find((value) => value !== null);
  return {
    priceChange: finiteNumber(strongest.priceChange ?? strongest.priceChange24h),
    volume: finiteNumber(strongest.volume),
    liquidity: finiteNumber(strongest.liquidity),
    volumeAcceleration: acceleration,
    liquidityChange,
  };
}

function formatAlphaCard(signal = {}, options = {}) {
  const symbol = cleanText(signal.symbol, "TOKEN").toUpperCase();
  const dex = dexSnapshot(signal);
  const lines = [symbol + " — EARLY MOMENTUM", ""];
  const facts = [
    ["Score", formatScore(signal.score)],
    ["Confidence", formatConfidence(signal.confidenceScore ?? signal.confidence)],
    ["Price", formatMoney(signal.price ?? dex.price)],
    ["24h", formatPercent(dex.priceChange ?? signal.priceChange)],
    ["Volume", formatMoney(dex.volume)],
    ["Volume pace", dex.volumeAcceleration === null || dex.volumeAcceleration === undefined ? null : formatNumber(dex.volumeAcceleration, 2) + "x"],
    ["Liquidity", formatMoney(dex.liquidity)],
    ["Liq. change", formatPercent(dex.liquidityChange)],
    ["Status", lifecycleLabel(signal, options.lifecycle)],
  ].filter(([, value]) => value);
  for (const [label, value] of facts) lines.push(label.padEnd(13) + value);
  const reasons = compactReasons(signal.reasons, 3);
  if (reasons.length) lines.push("", "Why it stands out", ...reasons.map((reason) => "- " + reason));
  return lines.join("\n").trim();
}

function signalKeyboard(signal = {}, tradingLinks = [], options = {}) {
  const symbol = cleanText(signal.symbol).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const venue = cleanText(signal.venue || options.venue || "Binance").replace(/[^A-Za-z]/g, "") || "Binance";
  const rows = [];
  if (symbol) {
    rows.push([
      { text: "Analyze", callback_data: "analyze:" + symbol + ":" + venue },
      { text: "Track", callback_data: "track:" + symbol },
    ]);
  }
  for (const row of tradingButtonRows(tradingLinks)) rows.push(row);
  return { inline_keyboard: rows };
}

function tradingButtonRows(tradingLinks = []) {
  const buttons = (Array.isArray(tradingLinks) ? tradingLinks : [])
    .filter((link) => link?.url && link?.venue)
    .map((link) => ({ text: "Trade on " + cleanText(link.venue), url: link.url }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return rows;
}

function formatWatchlist(symbols = []) {
  const list = (Array.isArray(symbols) ? symbols : []).map((item) => cleanText(item.symbol || item).toUpperCase()).filter(Boolean);
  if (!list.length) return emptyState("WATCHLIST", "No assets tracked yet.\n\nUse /watchlist add SOL");
  return ["WATCHLIST", "", ...list.map((symbol) => "- " + symbol), "", "Use /watchlist add SOL or /watchlist remove SOL"].join("\n");
}

function watchlistKeyboard(symbols = [], venue = "Binance") {
  const safeVenue = cleanText(venue, "Binance").replace(/[^A-Za-z]/g, "") || "Binance";
  const rows = (Array.isArray(symbols) ? symbols : []).slice(0, 8).map((item) => {
    const symbol = cleanText(item.symbol || item).toUpperCase().replace(/[^A-Z0-9]/g, "");
    return [
      { text: "Analyze " + symbol, callback_data: "analyze:" + symbol + ":" + safeVenue },
      { text: "Remove", callback_data: "watch_remove:" + symbol },
    ];
  });
  rows.push([{ text: "Settings", callback_data: "show_settings" }]);
  return { inline_keyboard: rows };
}

function formatHistory(symbol, rows = []) {
  const asset = cleanText(symbol, "ASSET").toUpperCase();
  if (!Array.isArray(rows) || !rows.length) return emptyState("HISTORY — " + asset, "No saved analyses yet.");
  const lines = ["HISTORY — " + asset, ""];
  for (const row of rows.slice(0, 8)) {
    const when = row.created_at ? new Date(String(row.created_at).replace(" ", "T") + "Z") : null;
    const date = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "Saved analysis";
    const score = formatScore(row.score) || "—";
    const lifecycle = cleanText(row.lifecycle_stage || row.category, "UNKNOWN").toUpperCase();
    lines.push(date, "Score " + score + " · " + lifecycle);
  }
  return lines.join("\n");
}

function comparisonField(label, left, right, formatter = cleanText) {
  const leftValue = formatter(left) || "—";
  const rightValue = formatter(right) || "—";
  return label.padEnd(11) + leftValue + " | " + rightValue;
}

function formatComparison(left = {}, right = {}) {
  const leftSymbol = cleanText(left.symbol, "A").toUpperCase();
  const rightSymbol = cleanText(right.symbol, "B").toUpperCase();
  const leftScore = finiteNumber(left.score) || 0;
  const rightScore = finiteNumber(right.score) || 0;
  const stronger = leftScore === rightScore ? "Neither has a clear score advantage." : (leftScore > rightScore ? leftSymbol : rightSymbol) + " currently has the stronger setup.";
  return [
    "COMPARE — " + leftSymbol + " vs " + rightSymbol,
    "",
    "           " + leftSymbol + " | " + rightSymbol,
    comparisonField("Score", left.score, right.score, formatScore),
    comparisonField("Confidence", left.confidenceScore, right.confidenceScore, formatConfidence),
    comparisonField("Trend", left.evidence?.mtfTrend, right.evidence?.mtfTrend),
    comparisonField("Funding", left.funding, right.funding, formatPercent),
    comparisonField("OI", left.oiChange, right.oiChange, formatPercent),
    comparisonField("Risk", left.conflicts?.[0], right.conflicts?.[0]),
    comparisonField("Lifecycle", left.lifecycleStage || left.category, right.lifecycleStage || right.category),
    "",
    stronger,
  ].join("\n");
}

function formatPerformance(report = {}) {
  if (report.status !== "ready") {
    return "PERPSIA PERFORMANCE\n\nPerpsIA is still collecting enough live signal outcomes to calculate reliable performance.";
  }
  const selected = report.horizons?.[report.selectedHorizon || "24h"];
  const stats = selected?.statistics;
  if (!stats) return "PERPSIA PERFORMANCE\n\nPerpsIA is still collecting enough live signal outcomes to calculate reliable performance.";
  return [
    "PERPSIA PERFORMANCE — " + (report.selectedHorizon || "24h"),
    "",
    "Signals       " + stats.observations,
    "Win rate      " + formatPercent(stats.winRate),
    "TP1 hit rate  " + formatPercent(stats.tp1HitRate),
    "TP2 hit rate  " + formatPercent(stats.tp2HitRate),
    "Stop rate     " + formatPercent(stats.stopRate),
    "Avg favorable " + formatPercent(stats.averageFavorableMove),
    "Avg adverse   " + formatPercent(stats.averageAdverseMove),
  ].join("\n");
}

function formatStatus({ providersOnline = true, databasePersistent = false, schedulerOnline = false } = {}) {
  return [
    "PERPSIA STATUS",
    "",
    "Market scanner      Online",
    "Data providers      " + (providersOnline ? "Online" : "Degraded"),
    "Signal engine       Online",
    "Telegram alerts     " + (schedulerOnline ? "Online" : "Manual only"),
    "Database            " + (databasePersistent ? "Persistent" : "Local"),
  ].join("\n");
}

function formatRiskProfile(settings) {
  if (!settings) return "RISK PROFILE\n\nNo profile configured.\n\nUse /risk 500 1 5";
  return [
    "RISK PROFILE",
    "",
    "Capital         " + formatMoney(settings.capital),
    "Risk per trade  " + formatNumber(settings.risk_percent ?? settings.riskPercent, 2) + "%",
    "Max leverage    " + formatNumber(settings.max_leverage ?? settings.maxLeverage, 2) + "x",
    "",
    "Update with /risk 500 1 5",
  ].join("\n");
}

function formatSettings(preferences = {}, watchlistCount = 0, riskSettings = null) {
  return [
    "PERPSIA SETTINGS",
    "",
    "Exchange          " + cleanText(preferences.preferred_exchange, "Binance"),
    "Alert frequency   " + cleanText(preferences.alert_frequency, "4h"),
    "Sensitivity       " + cleanText(preferences.signal_sensitivity, "balanced"),
    "Watchlist         " + Number(watchlistCount || 0) + " assets",
    "Risk profile      " + (riskSettings ? "Configured" : "Not configured"),
  ].join("\n");
}

function settingsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Binance", callback_data: "settings_venue:Binance" },
        { text: "Bybit", callback_data: "settings_venue:Bybit" },
      ],
      [
        { text: "OKX", callback_data: "settings_venue:OKX" },
        { text: "Hyperliquid", callback_data: "settings_venue:Hyperliquid" },
      ],
      [
        { text: "Alerts 1h", callback_data: "settings_frequency:1h" },
        { text: "Alerts 4h", callback_data: "settings_frequency:4h" },
        { text: "Alerts 12h", callback_data: "settings_frequency:12h" },
      ],
      [
        { text: "Conservative", callback_data: "settings_sensitivity:conservative" },
        { text: "Balanced", callback_data: "settings_sensitivity:balanced" },
        { text: "Aggressive", callback_data: "settings_sensitivity:aggressive" },
      ],
      [
        { text: "Watchlist", callback_data: "show_watchlist" },
        { text: "Risk Profile", callback_data: "set_risk" },
      ],
    ],
  };
}

function formatErrorState(title, error) {
  const raw = cleanText(error?.message || error);
  let message = "Please try again shortly.";
  if (/no candidates extracted/i.test(raw)) message = "No reliable market candidates were returned. Try again shortly.";
  else if (/cooldown|slow down/i.test(raw)) message = raw;
  else if (/unsupported exchange/i.test(raw)) message = raw;
  return cleanText(title, "PERPSIA UNAVAILABLE").toUpperCase() + "\n\n" + message;
}

module.exports = {
  ABOUT_MESSAGE,
  HELP_MESSAGE,
  PUBLIC_COMMANDS,
  WELCOME_MESSAGE,
  emptyState,
  escapeTelegramHtml,
  formatAlphaCard,
  formatComparison,
  formatErrorState,
  formatHeader,
  formatHistory,
  formatPerformance,
  formatProgress,
  formatRiskProfile,
  formatScanSummary,
  formatSettings,
  formatSignalCard,
  formatStatus,
  formatWatchlist,
  progressBar,
  registerPublicCommands,
  scanCounts,
  scanSummaryKeyboard,
  settingsKeyboard,
  signalKeyboard,
  startKeyboard,
  tradingButtonRows,
  watchlistKeyboard,
};
