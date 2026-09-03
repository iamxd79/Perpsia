require("dotenv").config();

const {
  buildReasoningBrief,
} = require("./services/openaiReasoning");

const {
  checkCooldown,
} = require("./services/rateLimit");
const {
  routeIntent,
} = require("./services/intentRouter");

const TelegramBot = require("node-telegram-bot-api").default;

// ========== TIER 1: PRODUCTION SCANNER WITH CMC CONNECTION ==========
const {
  runMarketScan,
  analyzeAsset,
} = require("./services/scannerV2");

const {
  isExchangeSupported,
  listSupportedExchanges,
} = require("./services/exchangeAdapter");

// ========== BACKTESTER FOR PAPER TRADING ==========
const { Backtester } = require("./services/backtester");

const {
  saveAssetState,
  getLastAssetState,
  compareAssetState,
  saveRiskSettings,
  getRiskSettings,
} = require("./services/memory");

const {
  getLifecycleStage,
  formatLifecycleUpdate,
} = require("./services/lifecycle");

const {
  getSignalDecay,
  formatSignalDecay,
} = require("./services/decay");

const {
  getCounterThesis,
  formatCounterThesis,
} = require("./services/counterThesis");

const {
  calculateRiskPlan,
  formatRiskPlan,
} = require("./services/riskEngine");

const {
  startScheduler,
} = require("./services/scheduler");

const {
  lockScan,
  unlockScan,
} = require("./services/scanLock");

// ==========================================
// ENVIRONMENT
// ==========================================

const token = process.env.TELEGRAM_BOT_TOKEN;
const autonomousChatId = process.env.TELEGRAM_CHAT_ID;

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is missing from .env");
  process.exit(1);
}

// ==========================================
// TELEGRAM BOT
// ==========================================

const bot = new TelegramBot(
  process.env.TELEGRAM_BOT_TOKEN,
  {
    polling: {
      autoStart: false,
      params: {
        timeout: 30,
      },
    },
  }
);

bot.on("polling_error", (error) => {
  const errorCode = error?.response?.body?.error_code;
  const errorMessage = error?.message || "";

  if (errorCode === 409 || /409 Conflict/i.test(errorMessage)) {
    console.error(
      "Telegram polling stopped: another process is already polling this bot token."
    );

    bot.stopPolling().catch(() => {});
    return;
  }

  console.error("Telegram polling error:", errorMessage);
});

// ==========================================
// GLOBAL LOCKS
// ==========================================

let isAnalyzeRunning = false;

// ==========================================
// PROGRESS BAR
// ==========================================

function progressBar(percent) {
  const total = 10;
  const filled = Math.round((percent / 100) * total);

  return "█".repeat(filled) + "░".repeat(10 - filled);
}

// ==========================================
// SAFE TELEGRAM MESSAGE EDIT
// ==========================================

async function safeEditMessage(chatId, messageId, text) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {}
}

// ==========================================
// FORMAT SCAN RESULT (v2)
// ==========================================

function formatScanResult(result) {
  const total =
    result.longs.length +
    result.shorts.length +
    result.watchlist.length +
    result.neutral.length;

  let output = `⚡ PERPSIA MARKET INTELLIGENCE

Assets analyzed: ${total}

🚀 Long Signals: ${result.longs.length}
🔻 Short Signals: ${result.shorts.length}
👀 Watchlist: ${result.watchlist.length}
⚪ Neutral / Avoid: ${result.neutral.length}
⚠️ Data Issues: ${result.errors.length}

`;

  if (result.longs.length > 0) {
    output += `🚀 LONG SIGNALS\n\n`;
    result.longs.forEach((signal) => {
      output += `$${signal.symbol} — ${signal.score}/100\nMarket State: ${signal.marketState}\n\n`;
    });
  }

  if (result.shorts.length > 0) {
    output += `\n🔻 SHORT SIGNALS\n\n`;
    result.shorts.forEach((signal) => {
      output += `$${signal.symbol} — ${signal.score}/100\nMarket State: ${signal.marketState}\n\n`;
    });
  }

  if (result.watchlist.length > 0) {
    output += `\n👀 WATCHLIST\n\n`;
    result.watchlist.slice(0, 5).forEach((signal) => {
      output += `$${signal.symbol} — ${signal.score}/100\nMarket State: ${signal.marketState}\n\n`;
    });
  }

  if (result.errors.length > 0) {
    output += `\n⚠️ DATA ISSUES\n\n`;
    result.errors.slice(0, 5).forEach((error) => {
      output += `$${error.symbol}: ${error.reason}\n`;
    });
  }

  return output;
}

// ==========================================
// START COMMAND
// ==========================================

function getHelpMessage() {
  return `⚙️ PERPSIA COMMANDS

🔎 /scan
Scan the perpetual futures market with live CMC data.

🧠 /analyze BTC [venue]
Run deep analysis on any supported futures asset.

Examples:
/analyze BTC
/analyze BLUR OKX
/analyze SOL Bybit

Supported venues: Binance, Bybit, OKX, Dydx, Hyperliquid

🛡️ /risk 500 1 5
Set your risk profile.

Capital: $500
Risk: 1%
Max leverage: 5x

🟢 /status
Check agent status.

🆔 /chatid
Get your Telegram chat ID.

📊 /backtest BTC
Run paper trading backtest (experimental).

You can also talk naturally:

"Analyze BTC"
"Scan the market"
"I have $500, risk 1%, max leverage 5x"
"Check Perpsia status"`;
}

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `⚡ WELCOME TO PERPSIA

Your autonomous perpetual futures market intelligence agent.

Perpsia scans the market with LIVE CoinMarketCap Skill Hub data, analyzes opportunities, tracks how setups evolve, and alerts you when meaningful changes are detected.

Powered by <a href="https://coinmarketcap.com/api/skills-marketplace/">CoinMarketCap Skill Hub</a>, multi-exchange support, and AI reasoning.

You can talk naturally.

Try:

<code>Analyze BTC</code>

<code>Scan the market</code>

<code>I have $500, risk 1%, max leverage 5x</code>

What would you like to do?`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔎 Scan Market", callback_data: "scan_market" },
            { text: "🧠 Analyze Asset", callback_data: "analyze_asset" },
          ],
          [
            { text: "🛡️ Set Risk", callback_data: "set_risk" },
            { text: "⚙️ Commands", callback_data: "show_commands" },
          ],
          [
            { text: "🌐 Learn More", url: "https://perpsia.vercel.app/" },
          ],
        ],
      },
    }
  );
});

// ==========================================
// HELP COMMAND
// ==========================================

bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id, getHelpMessage());
});

// ==========================================
// RISK SETTINGS COMMAND
// ==========================================

bot.onText(
  /\/risk\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/,
  async (msg, match) => {
    const chatId = msg.chat.id;

    const capital = Number(match[1]);
    const riskPercent = Number(match[2]);
    const maxLeverage = Number(match[3]);

    if (
      !Number.isFinite(capital) ||
      !Number.isFinite(riskPercent) ||
      !Number.isFinite(maxLeverage) ||
      capital <= 0 ||
      riskPercent <= 0 ||
      maxLeverage <= 0
    ) {
      return bot.sendMessage(
        chatId,
        `⚠️ Invalid risk settings.

Use:

/risk 500 1 5

Capital: $500
Risk per trade: 1%
Maximum leverage: 5x`
      );
    }

    saveRiskSettings(
      chatId,
      capital,
      riskPercent,
      maxLeverage
    );

    await bot.sendMessage(
      chatId,
      `🛡️ RISK PROFILE UPDATED

Capital: $${capital}
Risk per trade: ${riskPercent}%
Maximum leverage: ${maxLeverage}x

Perpsia will apply this profile when an actionable LONG or SHORT setup is detected.`
    );
  }
);

// ==========================================
// MARKET SCAN RUNNER (v2 - LIVE CMC)
// ==========================================

async function runManualScan(chatId, venue = "Binance") {
  if (!lockScan()) {
    return bot.sendMessage(
      chatId,
      `⏳ PERPSIA SCAN IN PROGRESS

Another CMC Skill Hub scan is already running.

Please wait for the current scan to finish.`
    );
  }

  const loading = await bot.sendMessage(
    chatId,
    `🟢 PERPSIA LIVE SCAN — ${venue}

${progressBar(5)} 5%

Booting market intelligence engine...`
  );

  try {
    const result = await runMarketScan(venue, async (progress) => {
      await safeEditMessage(
        chatId,
        loading.message_id,
        `🟢 PERPSIA LIVE SCAN — ${venue}

${progressBar(progress.percent)} ${progress.percent}%

${progress.message}

Current stage:
${progress.stage}`
      );
    });

    await safeEditMessage(
      chatId,
      loading.message_id,
      `✅ PERPSIA SCAN COMPLETE — ${venue}

${progressBar(100)} 100%

Preparing market intelligence report...`
    );

    await bot.sendMessage(chatId, formatScanResult(result));
  } catch (error) {
    console.error("Manual market scan failed:", error);

    await safeEditMessage(
      chatId,
      loading.message_id,
      `❌ PERPSIA SCAN FAILED

Reason:

${error.message}${/CMC_(?:MCP_ENDPOINT|API_KEY)/i.test(error.message) ? "\n\nMake sure CMC_MCP_ENDPOINT and CMC_API_KEY are configured." : ""}`
    );
  } finally {
    unlockScan();
  }
}

// ==========================================
// MARKET SCAN COMMAND
// ==========================================

bot.onText(/\/scan(?:\s+([A-Za-z]+))?/, async (msg, match) => {
  const venue = match[1] || "Binance";

  if (!isExchangeSupported(venue)) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Unsupported exchange: ${venue}

Supported: ${listSupportedExchanges()
  .map((e) => e.name)
  .join(", ")}`
    );
  }

  const cooldown = checkCooldown(msg.chat.id, "scan");

  if (!cooldown.allowed) {
    return bot.sendMessage(
      msg.chat.id,
      `Slow down. You can scan again in ${cooldown.remainingSeconds}s.`
    );
  }

  await runManualScan(msg.chat.id, venue);
});

// ==========================================
// ASSET ANALYSIS COMMAND (v2 - LIVE CMC)
// ==========================================

async function runAssetAnalysis(
  chatId,
  symbol,
  venue = "Binance"
) {
  symbol = String(symbol || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase();

  if (!isExchangeSupported(venue)) {
    return bot.sendMessage(
      chatId,
      `❌ Unsupported exchange: ${venue}

Supported: ${listSupportedExchanges()
  .map((e) => e.name)
  .join(", ")}`
    );
  }

  const cooldown = checkCooldown(chatId, "analyze");

  if (!cooldown.allowed) {
    return bot.sendMessage(
      chatId,
      `Slow down. You can analyze again in ${cooldown.remainingSeconds}s.`
    );
  }

  if (isAnalyzeRunning) {
    return bot.sendMessage(
      chatId,
      `⏳ PERPSIA ANALYSIS IN PROGRESS

Another asset analysis is already running.

Please wait for it to finish.`
    );
  }

  isAnalyzeRunning = true;

  const loading = await bot.sendMessage(
    chatId,
    `🔎 PERPSIA ASSET ANALYSIS — $${symbol} on ${venue}

${progressBar(5)} 5%

Starting deep market analysis...`
  );

  try {
    // ======================================
    // LOAD PREVIOUS MEMORY
    // ======================================

    const previous = getLastAssetState(symbol);

    // ======================================
    // RUN CMC SKILL HUB ANALYSIS (LIVE)
    // ======================================

    const result = await analyzeAsset(
      symbol,
      venue,
      async (progress) => {
        await safeEditMessage(
          chatId,
          loading.message_id,
          `🔎 PERPSIA ASSET ANALYSIS — $${symbol} on ${venue}

${progressBar(progress.percent)} ${progress.percent}%

${progress.message}

Current stage:
${progress.stage}`
        );
      }
    );

    // ======================================
    // LIFECYCLE ENGINE
    // ======================================

    const lifecycle = getLifecycleStage(
      result,
      previous
    );

    result.lifecycleStage = lifecycle.stage;

    // ======================================
    // SIGNAL DECAY ENGINE
    // ======================================

    const decay = getSignalDecay(
      result,
      previous
    );

    // ======================================
    // COUNTER-THESIS ENGINE
    // ======================================

    const counterThesis =
      getCounterThesis(result);

    // ======================================
    // MEMORY COMPARISON
    // ======================================

    const memoryChange = compareAssetState(
      previous,
      result
    );

    // ======================================
    // PERSONALIZED RISK ENGINE
    // ======================================

    const riskSettings =
      getRiskSettings(chatId);

    const riskPlan = riskSettings
      ? calculateRiskPlan(result, {
          capital: riskSettings.capital,
          riskPercent:
            riskSettings.risk_percent,
          maxLeverage:
            riskSettings.max_leverage,
        })
      : null;

    // ======================================
    // SAVE NEW MEMORY STATE
    // ======================================

    saveAssetState(result);

    // ======================================
    // BUILD PERPSIA REPORT
    // ======================================

    let report = ``;

    if (!result.hasCoreData) {
      report = `⚠️ PERPSIA ANALYSIS — $${symbol}

Status: INSUFFICIENT DATA

The CMC skills returned data, but Perpsia could not extract enough reliable market fields to classify this asset.

🔎 Verdict

No signal generated.`;
    } else {
      const icon =
        result.category === "long"
          ? "🚀"
          : result.category === "short"
          ? "🔻"
          : result.category === "watchlist"
          ? "👀"
          : "⚪";

      report = `${icon} PERPSIA ANALYSIS — $${symbol}

Market State: ${result.marketState}
Category: ${result.category.toUpperCase()}
Direction: ${result.direction}
Score: ${result.score}/100

📊 MARKET DATA

💰 Price: ${result.price}
📈 Price Change: ${result.priceChange}%
🧲 OI Change: ${result.oiChange}%
⚖️ Funding: ${result.funding}%

🧠 WHY

${result.reasons.slice(0, 4).map((r) => `• ${r}`).join("\n")}
`;

      if (result.isActionable) {
        report += `

🎯 TRADE PLAN

Entry: ${result.entry}
TP1: ${result.tp1}
TP2: ${result.tp2}
🛑 Invalidation: ${result.stop}`;
      } else {
        report += `

🎯 TRADE PLAN

No active entry yet.

This is a monitoring setup, not a confirmed trade.

🔍 CONFIRMATION NEEDED

${result.confirmationNeeded.map((item) => `• ${item}`).join("\n")}`;
      }
    }

    // ======================================
    // ADD LIFECYCLE, DECAY, COUNTER-THESIS
    // ======================================

    const lifecycleText = formatLifecycleUpdate(lifecycle);
    const decayText = formatSignalDecay(decay);
    const counterText = formatCounterThesis(counterThesis);

    // ======================================
    // PERSONALIZED RISK OUTPUT
    // ======================================

    let riskText = "";

    if (result.isActionable) {
      riskText = riskPlan
        ? formatRiskPlan(riskPlan)
        : `🛡️ PERSONALIZED RISK ENGINE

No risk profile configured.

Set your profile with:

/risk 500 1 5`;
    }

    // ======================================
    // FINAL MESSAGE
    // ======================================

    const finalMessage = [
      report,
      lifecycleText,
      decayText,
      counterText,
      riskText,
    ]
      .filter(Boolean)
      .join("\n\n");

    // ======================================
    // COMPLETE PROGRESS MESSAGE
    // ======================================

    await safeEditMessage(
      chatId,
      loading.message_id,
      `✅ $${symbol} ANALYSIS COMPLETE

${progressBar(100)} 100%

Perpsia intelligence report ready.`
    );

    await bot.sendMessage(
      chatId,
      finalMessage
    );
  } catch (error) {
    console.error(
      `Analysis failed for ${symbol}:`,
      error
    );

    await safeEditMessage(
      chatId,
      loading.message_id,
      `❌ $${symbol} ANALYSIS FAILED

Reason:

${error.message}`
    );
  } finally {
    isAnalyzeRunning = false;
  }
}

// ==========================================
// /ANALYZE COMMAND ROUTER
// ==========================================

bot.onText(
  /\/analyze\s+\$?([A-Za-z0-9]+)(?:\s+([A-Za-z]+))?/,
  async (msg, match) => {
    const chatId = msg.chat.id;

    const symbol =
      match[1].toUpperCase();

    const venue =
      match[2] || "Binance";

    await runAssetAnalysis(
      chatId,
      symbol,
      venue
    );
  }
);

// ==========================================
// NATURAL LANGUAGE INTENT ROUTER
// ==========================================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;
  if (text.startsWith("/")) return;

  const DIRECT_TEXT_WORDS = new Set([
    "HI",
    "HELLO",
    "HEY",
    "THANKS",
    "THANK",
    "STATUS",
    "HELP",
    "SCAN",
  ]);

  const symbolOnlyMatch = text.match(/^\$?([A-Za-z0-9]{2,15})$/);

  if (symbolOnlyMatch) {
    const symbol = symbolOnlyMatch[1].toUpperCase();

    if (!DIRECT_TEXT_WORDS.has(symbol)) {
      return runAssetAnalysis(chatId, symbol, "Binance");
    }
  }

  try {
    await bot.sendChatAction(chatId, "typing");

    const cooldown = checkCooldown(chatId, "intent");

    if (!cooldown.allowed) {
      return bot.sendMessage(
        chatId,
        `Slow down. You can send another request in ${cooldown.remainingSeconds}s.`
      );
    }

    const route = await routeIntent(text);

    console.log("Perpsia routed intent:", route);

    if (
      !route ||
      route.intent === "unknown" ||
      Number(route.confidence || 0) < 0.7
    ) {
      return bot.sendMessage(
        chatId,
        `I'm not sure what you want me to do.

Try:

Analyze BTC
Scan the market
I have $500, risk 1%, max leverage 5x
Check Perpsia status`
      );
    }

    if (route.intent === "conversation") {
      return bot.sendMessage(
        chatId,
        route.reply ||
          "I'm online. Send me an asset or ask me to scan the market."
      );
    }

    if (route.intent === "analyze_asset") {
      if (!route.symbol) {
        return bot.sendMessage(
          chatId,
          "Tell me which asset you want me to analyze."
        );
      }

      return runAssetAnalysis(
        chatId,
        String(route.symbol).replace(/^\$/, "").toUpperCase(),
        route.venue || "Binance"
      );
    }

    if (route.intent === "scan_market") {
      return runManualScan(chatId, "Binance");
    }

    if (route.intent === "set_risk") {
      const capital = Number(route.capital);
      const riskPercent = Number(route.riskPercent);
      const maxLeverage = Number(route.maxLeverage);

      if (
        !Number.isFinite(capital) ||
        !Number.isFinite(riskPercent) ||
        !Number.isFinite(maxLeverage) ||
        capital <= 0 ||
        riskPercent <= 0 ||
        maxLeverage <= 0
      ) {
        return bot.sendMessage(
          chatId,
          `I need all 3 values.

Example:
I have $500, risk 1%, max leverage 5x`
        );
      }

      saveRiskSettings(chatId, capital, riskPercent, maxLeverage);

      return bot.sendMessage(
        chatId,
        `🛡️ Risk profile updated.

Capital: $${capital}
Risk per trade: ${riskPercent}%
Max leverage: ${maxLeverage}x`
      );
    }

    if (route.intent === "status") {
      return bot.sendMessage(
        chatId,
        `🟢 Perpsia is online.

CMC Skill Hub: Connected
Memory: Active
Lifecycle: Active
Smart Alerts: Active
Multi-Exchange: Active
Request Queue: Active`
      );
    }

    if (route.intent === "help") {
      return bot.sendMessage(chatId, getHelpMessage());
    }

    return bot.sendMessage(
      chatId,
      "I understood you, but I can't execute that action yet."
    );
  } catch (error) {
    console.error("Natural language routing failed:", error);

    return bot.sendMessage(
      chatId,
      `I couldn't process that request.

Please try again or use /help.`
    );
  }
});

// ==========================================
// INLINE BUTTON HANDLER
// ==========================================

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === "scan_market") {
    return runManualScan(chatId, "Binance");
  }

  if (action === "analyze_asset") {
    return bot.sendMessage(
      chatId,
      `Send me the asset you want to analyze.

Example:
Analyze BTC

Or use:
/analyze BTC`
    );
  }

  if (action === "set_risk") {
    return bot.sendMessage(
      chatId,
      `Set your risk profile like this:

/risk 500 1 5

Or say naturally:

I have $500, risk 1%, max leverage 5x`
    );
  }

  if (action === "show_commands") {
    return bot.sendMessage(chatId, getHelpMessage());
  }
});

// ==========================================
// CHAT ID COMMAND
// ==========================================

bot.onText(/\/chatid/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `🆔 TELEGRAM CHAT ID

${msg.chat.id}

This ID can be used for autonomous Perpsia reports, alerts, and deployment configuration.`
  );
});

// ==========================================
// STATUS COMMAND
// ==========================================

bot.onText(/\/status/, async (msg) => {
  const schedulerStatus = autonomousChatId
    ? "ACTIVE"
    : "NOT CONFIGURED";

  await bot.sendMessage(
    msg.chat.id,
    `🟢 PERPSIA AGENT STATUS

Agent: ONLINE
Telegram: CONNECTED
CMC Skill Hub: CONNECTED (LIVE)
Memory Engine: ACTIVE
Lifecycle Engine: ACTIVE
Signal Decay Engine: ACTIVE
Counter-Thesis Engine: ACTIVE
Risk Engine: ACTIVE
Request Queue: ACTIVE
Multi-Exchange Support: ACTIVE
4H Autonomous Scheduler: ${schedulerStatus}`
  );
});

bot.startPolling().catch((error) => {
  console.error("Telegram polling failed to start:", error.message);
  process.exitCode = 1;
});

// ==========================================
// START AUTONOMOUS SCHEDULER
// ==========================================

startScheduler({
  bot,
  chatId: autonomousChatId,
});

// ==========================================
// RENDER HEALTH SERVER
// ==========================================

const http = require("http");

const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        status: "online",
        service: "Perpsia Terminal",
        version: "2.0.0-tier1-live",
        features: [
          "live-cmc-integration",
          "multi-exchange",
          "request-queue",
          "backtester-ready",
        ],
      })
    );
  })
  .listen(PORT, () => {
    console.log(
      `Perpsia health server listening on port ${PORT}`
    );
  });

// ==========================================
// STARTUP
// ==========================================

console.log("✅ Perpsia Terminal v2.0 is running...");
console.log("📡 TIER 1 CRITICAL GAPS RESOLVED:");
console.log("   ✅ Live CMC Skill Hub connection");
console.log("   ✅ Request queue with retry logic");
console.log("   ✅ Multi-exchange support (Binance, Bybit, OKX, Dydx, Hyperliquid)");
console.log("   ✅ Backtester framework (ready for integration)");
