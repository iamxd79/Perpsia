const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HELP_MESSAGE,
  PUBLIC_COMMANDS,
  WELCOME_MESSAGE,
  escapeTelegramHtml,
  formatAlphaCard,
  formatProgress,
  formatScanSummary,
  formatSignalCard,
  registerPublicCommands,
  scanSummaryKeyboard,
  startKeyboard,
  watchlistKeyboard,
} = require("../services/telegramUi");

test("registers the public Telegram command menu", async () => {
  let received = null;
  await registerPublicCommands({
    setMyCommands(commands) {
      received = commands;
      return Promise.resolve(true);
    },
  });

  assert.deepEqual(received, PUBLIC_COMMANDS);
  assert.deepEqual(
    received.map(({ command }) => command),
    ["start", "scan", "analyze", "alpha", "risk", "watchlist", "history", "compare", "backtest", "performance", "status", "settings", "help", "about"]
  );
  assert.deepEqual(Object.fromEntries(received.map(({ command, description }) => [command, description])), {
    start: "Open PerpsIA",
    scan: "Find current perp setups",
    analyze: "Analyze one asset",
    alpha: "Find early momentum",
    risk: "Set your risk profile",
    watchlist: "Manage tracked assets",
    history: "View past analyses",
    compare: "Compare two assets",
    backtest: "Test past signals",
    performance: "View signal results",
    status: "Check PerpsIA status",
    settings: "Change preferences",
    help: "View commands",
    about: "About PerpsIA",
  });
});

test("renders the concise start and help experiences", () => {
  assert.match(WELCOME_MESSAGE, /^WELCOME TO PERPSIA/);
  assert.match(HELP_MESSAGE, /Find trades[\s\S]*\/scan[\s\S]*Research[\s\S]*\/compare[\s\S]*Manage[\s\S]*\/settings/);
  assert.deepEqual(
    startKeyboard().inline_keyboard.map((row) => row.map((button) => button.text)),
    [["Scan Market", "Analyze Token"], ["Early Alpha", "Set Risk"], ["Watchlist", "More"]]
  );
});

test("renders one friendly scan progress message", () => {
  const progress = formatProgress({
    kind: "scan",
    venue: "Bybit",
    percent: 64,
    stage: "$SOL Orderbook Pressure",
    current: 8,
    total: 20,
  });
  assert.match(progress, /PERPSIA LIVE SCAN/);
  assert.match(progress, /Reading order books/);
  assert.match(progress, /8 \/ 20 markets analyzed/);
  assert.equal((progress.match(/64%/g) || []).length, 1);
});

test("renders compact scan summary and drill-down buttons", () => {
  const summary = formatScanSummary({
    longs: [{ symbol: "BTC" }],
    shorts: [{ symbol: "ETH" }],
    watchlist: [{ symbol: "SOL" }],
    neutral: [{ symbol: "XRP" }],
    errors: [{ symbol: "DOGE" }],
  }, { venue: "OKX" });
  assert.match(summary, /2 strong setups/);
  assert.match(summary, /1 watchlist/);
  assert.match(summary, /2 filtered out/);
  assert.deepEqual(
    scanSummaryKeyboard("OKX").inline_keyboard.flat().map((button) => button.text),
    ["View Top Setups", "View Watchlist", "Run Again"]
  );
});

test("signal cards omit unavailable fields instead of inventing values", () => {
  const card = formatSignalCard({
    symbol: "SOL",
    direction: "Bullish",
    category: "watchlist",
    score: 71,
    confidenceScore: 68,
    price: 142.25,
    priceChange: 4.2,
    funding: "N/A",
    oiChange: null,
    entry: "N/A",
    tp1: null,
    stop: undefined,
    reasons: ["Price and spot volume are strengthening."],
    isActionable: false,
  });
  assert.match(card, /SOL — MARKET WATCH/);
  assert.match(card, /Score\s+7\.1\/10/);
  assert.match(card, /Price\s+\$142\.25/);
  assert.doesNotMatch(card, /Funding|Entry|TP1|Stop|N\/A/);
});

test("alpha cards only show observed DEX metrics", () => {
  const card = formatAlphaCard({
    symbol: "ALPHA",
    score: 82,
    confidenceScore: 0.74,
    price: 0.012,
    marketEvidence: [{
      provider: "dexscreener",
      status: "ok",
      priceChange: 24,
      volume: 1500000,
      liquidity: 420000,
      metadata: { volumeAcceleration: 2.4 },
    }],
  });
  assert.match(card, /ALPHA — EARLY MOMENTUM/);
  assert.match(card, /Volume\s+\$1,500,000/);
  assert.match(card, /Volume pace\s+2\.4x/);
  assert.match(card, /Liquidity\s+\$420,000/);
  assert.doesNotMatch(card, /Liq\. change/);
});

test("escapes Telegram HTML metacharacters", () => {
  assert.equal(
    escapeTelegramHtml(`<b>A&B</b> "quote" 'single'`),
    "&lt;b&gt;A&amp;B&lt;/b&gt; &quot;quote&quot; &#39;single&#39;"
  );
});

test("watchlist analysis buttons respect the preferred venue", () => {
  const keyboard = watchlistKeyboard([{ symbol: "HYPE" }], "Hyperliquid");
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "analyze:HYPE:Hyperliquid");
  assert.equal(keyboard.inline_keyboard.at(-1)[0].callback_data, "show_settings");
});
