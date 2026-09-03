const { runMarketScan } = require("./scannerV2");
const { normalizeVenue } = require("./exchangeAdapter");




const {
  getLastAssetState,
  saveAssetState,
  saveAlert,
} = require("./memory");




const { getLifecycleStage } = require("./lifecycle");




const {
  shouldSendAlert,
  formatSmartAlert,
} = require("./alertEngine");




const {
  lockScan,
  unlockScan,
} = require("./scanLock");




const {
  recordSignal: recordPerformanceSignal,
  evaluateSignalOutcomes,
} = require("./performance");
const {
  recordSignal: recordTelemetrySignal,
  recordScan,
} = require("./telemetry");






function getNow() {
  return new Date().toISOString();
}




function progressBar(percent) {
  const total = 10;
  const filled = Math.round((percent / 100) * total);
  return "█".repeat(filled) + "░".repeat(total - filled);
}




async function safeEditMessage(bot, chatId, messageId, text) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {
    // ignore duplicate edit errors
  }
}




function flattenScanResults(result) {
  return [
    ...result.longs,
    ...result.shorts,
    ...result.watchlist,
    ...result.neutral,
  ];
}




function formatSilentReport(result, alertCount) {
  const total =
    result.longs.length +
    result.shorts.length +
    result.watchlist.length +
    result.neutral.length;




  return `🤖 PERPSIA 4H SCAN COMPLETE

No major alert triggered.

Market Summary:
Assets analyzed: ${total}
Long signals: ${result.longs.length}
Short signals: ${result.shorts.length}
Watchlist: ${result.watchlist.length}
Neutral / Avoid: ${result.neutral.length}
Data issues: ${result.errors.length}

Alerts sent: ${alertCount}

Perpsia will keep monitoring.`;
}




async function runScheduledScan({ bot, chatId, venue }) {
  if (!chatId) {
    console.log("Scheduler skipped: TELEGRAM_CHAT_ID is missing.");
    return;
  }




  const selectedVenue = normalizeVenue(
    venue || process.env.PERPSIA_DEFAULT_VENUE || "Binance"
  );




  if (!lockScan()) {
    console.log("Scheduler skipped: another CMC scan is already running.");
    return;
  }




  console.log(`[${getNow()}] Scheduled scan started.`);




  const loading = await bot.sendMessage(
    chatId,
    `🤖 PERPSIA AUTONOMOUS SCAN

${progressBar(5)} 5%

Booting scheduled market intelligence scan...`
  );




  try {
    const result = await runMarketScan(selectedVenue, async (progress) => {
      await safeEditMessage(
        bot,
        chatId,
        loading.message_id,
        `🤖 PERPSIA AUTONOMOUS SCAN

${progressBar(progress.percent)} ${progress.percent}%

${progress.message}

Current stage:
${progress.stage}`
      );
    });




    await safeEditMessage(
      bot,
      chatId,
      loading.message_id,
      `✅ PERPSIA AUTONOMOUS SCAN COMPLETE

${progressBar(100)} 100%

Checking memory and alert conditions...`
    );




    const allSignals = flattenScanResults(result);
    let alertCount = 0;




    for (const signal of allSignals) {
      const previous = getLastAssetState(signal.symbol);




      const lifecycle = getLifecycleStage(signal, previous);
      signal.lifecycleStage = lifecycle.stage;




      const alertDecision = shouldSendAlert(signal, previous);




      saveAssetState(signal);
      recordTelemetrySignal(signal);
      recordPerformanceSignal(signal, "scheduled_scan");




      if (!alertDecision.shouldAlert) continue;




      const alertMessage = formatSmartAlert(signal, alertDecision);




      await bot.sendMessage(chatId, alertMessage);




      saveAlert(signal.symbol, alertDecision.alertType, alertMessage);




      alertCount++;
    }




    recordScan("scheduled", "success");


    if (alertCount === 0) {
      await bot.sendMessage(chatId, formatSilentReport(result, alertCount));
    }




    const qualityEvaluation = await evaluateSignalOutcomes({ limit: 100 });
    console.log(`[${getNow()}] Signal quality evaluation completed. Evaluated: ${qualityEvaluation.evaluated}, pending: ${qualityEvaluation.pending}, errors: ${qualityEvaluation.errors.length}`);

    console.log(`[${getNow()}] Scheduled scan completed. Alerts: ${alertCount}`);
  } catch (error) {
    console.error("Scheduled scan failed:", error);
    recordScan("scheduled", "error");




    await safeEditMessage(
      bot,
      chatId,
      loading.message_id,
      `❌ PERPSIA SCHEDULED SCAN FAILED

Reason:
${error.message}`
    );
  } finally {
    unlockScan();
  }
}




function startScheduler({ bot, chatId, intervalMs = 4 * 60 * 60 * 1000, venue }) {
  if (!bot) {
    throw new Error("Scheduler requires bot instance.");
  }




  if (!chatId) {
    console.log("Scheduler not started: TELEGRAM_CHAT_ID missing.");
    return;
  }




  console.log(`Perpsia smart alert scheduler started. Interval: ${intervalMs}ms`);




  setInterval(() => {
    runScheduledScan({ bot, chatId, venue });
  }, intervalMs);
}




module.exports = {
  startScheduler,
  runScheduledScan,
};
