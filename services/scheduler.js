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




async function withTelegramTimeout(promise, label) {
  const timeoutMs = Math.min(Math.max(Number(process.env.PERPSIA_TELEGRAM_TIMEOUT_MS || 30000), 5000), 120000);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(label + " timed out after " + timeoutMs + "ms");
      error.code = "TELEGRAM_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
async function safeEditMessage(bot, chatId, messageId, text) {
  if (!messageId) return;
  try {
    await withTelegramTimeout(bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
    }), "Telegram edit");
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

No confirmed setup on this scan.

Market Summary:
Assets analyzed: ${total}
Long candidates: ${result.longs.length}
Short candidates: ${result.shorts.length}
Watchlist candidates: ${result.watchlist.length}
Developing conditions: ${result.neutral.length}
Data quality issues: ${result.errors.length}

Alerts sent: ${alertCount}

PerpsIA will keep tracking market development.`;
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




  schedulerState.lastRunAt = new Date().toISOString();
  schedulerState.lastRunStatus = "running";
  schedulerState.lastError = null;
  schedulerState.lastProgressAt = new Date().toISOString();
  schedulerState.lastProgress = { percent: 0, stage: "startup", message: "Starting scheduled scan" };
  console.log("Scheduled scan started.");




  const configuredScanTimeoutMs = Number(process.env.PERPSIA_SCHEDULER_SCAN_TIMEOUT_MS || 12 * 60 * 1000);
  const scanTimeoutMs = Math.min(Math.max(Number.isFinite(configuredScanTimeoutMs) ? configuredScanTimeoutMs : 12 * 60 * 1000, 60 * 1000), 30 * 60 * 1000);
  // Leave a safety margin so the scan can classify and persist partial results before the watchdog.
  const scanSafetyMarginMs = Math.min(Math.max(Number(process.env.PERPSIA_SCAN_SAFETY_MARGIN_MS || 30000), 10000), 120000);
  const scanDeadlineAt = Date.now() + Math.max(1000, scanTimeoutMs - scanSafetyMarginMs);
  const runStartedAt = schedulerState.lastRunAt;
  let scanTimedOut = false;
  const scanWatchdog = setTimeout(() => {
    if (schedulerState.lastRunAt !== runStartedAt || schedulerState.lastRunStatus !== "running") return;
    scanTimedOut = true;
    schedulerState.lastRunStatus = "timeout";
    schedulerState.lastError = "Scheduled scan exceeded " + scanTimeoutMs + "ms";
    schedulerState.lastProgressAt = new Date().toISOString();
    schedulerState.lastProgress = { percent: schedulerState.lastProgress?.percent || 0, stage: "timeout", message: schedulerState.lastError };
    unlockScan();
  }, scanTimeoutMs);

  let loading = null;

  try {
    loading = await withTelegramTimeout(bot.sendMessage(
    chatId,
    `🤖 PERPSIA AUTONOMOUS SCAN

${progressBar(5)} 5%

Booting scheduled market intelligence scan...`
  ), "Telegram initial progress");




    const result = await runMarketScan(selectedVenue, async (progress) => {
      schedulerState.lastProgressAt = new Date().toISOString();
      schedulerState.lastProgress = { percent: progress.percent, stage: progress.stage, message: progress.message };
      await safeEditMessage(
        bot,
        chatId,
        loading?.message_id,
        `🤖 PERPSIA AUTONOMOUS SCAN

${progressBar(progress.percent)} ${progress.percent}%

${progress.message}

Current stage:
${progress.stage}`
      );
    }, { deadlineAt: scanDeadlineAt });

    if (scanTimedOut) throw new Error("Scheduled scan completed after watchdog timeout.");



    await safeEditMessage(
      bot,
      chatId,
      loading?.message_id,
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




      await withTelegramTimeout(bot.sendMessage(chatId, alertMessage), "Telegram alert");




      saveAlert(signal.symbol, alertDecision.alertType, alertMessage);




      alertCount++;
    }




    recordScan("scheduled", "success");
    schedulerState.lastRunStatus = "success";
    schedulerState.lastError = null;
    schedulerState.lastSignalCounts = {
      long: result.longs.length,
      short: result.shorts.length,
      watchlist: result.watchlist.length,
      neutral: result.neutral.length,
      errors: result.errors.length,
    };
    const diagnosticSignals = [
      ...result.longs,
      ...result.shorts,
      ...result.watchlist,
      ...result.neutral,
    ]
      .slice()
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
      .slice(0, 20)
      .map((signal) => ({
        symbol: signal.symbol,
        category: signal.category,
        direction: signal.direction,
        score: signal.score,
        marketState: signal.marketState,
        hasCoreData: signal.hasCoreData,
        analysisDepth: signal.analysisDepth,
        confirmationNeeded: Array.isArray(signal.confirmationNeeded)
          ? signal.confirmationNeeded.slice(0, 4)
          : [],
        reasons: Array.isArray(signal.reasons) ? signal.reasons.slice(0, 4) : [],
      }));
    schedulerState.lastScanDiagnostics = {
      candidateCount: result.longs.length + result.shorts.length + result.watchlist.length + result.neutral.length,
      topCandidates: diagnosticSignals,
    };

    if (alertCount === 0) {
      await withTelegramTimeout(bot.sendMessage(chatId, formatSilentReport(result, alertCount)), "Telegram silent report");
    }




    const qualityEvaluation = await evaluateSignalOutcomes({ limit: 100 });
    console.log(`[${getNow()}] Signal quality evaluation completed. Evaluated: ${qualityEvaluation.evaluated}, pending: ${qualityEvaluation.pending}, errors: ${qualityEvaluation.errors.length}`);

    console.log(`[${getNow()}] Scheduled scan completed. Alerts: ${alertCount}`);
  } catch (error) {
    if (scanTimedOut) return;
    schedulerState.lastRunStatus = "error";
    schedulerState.lastError = String(error?.message || error);
    console.error("Scheduled scan failed:", error);
    recordScan("scheduled", "error");




    await safeEditMessage(
      bot,
      chatId,
      loading?.message_id,
      `❌ PERPSIA SCHEDULED SCAN FAILED

Reason:
${error.message}`
    );
  } finally {
    clearTimeout(scanWatchdog);
    unlockScan();
  }
}




let schedulerTimer = null;
let schedulerState = {
  configured: false,
  startedAt: null,
  intervalMs: null,
  venue: null,
  initialDelayMs: null,
  initialRunScheduled: false,
  lastRunAt: null,
  lastRunStatus: null,
  lastError: null,
  lastProgressAt: null,
  lastProgress: null,
  lastSignalCounts: null,
  lastScanDiagnostics: null,
};

function getSchedulerHealth() {
  return {
    configured: schedulerState.configured,
    running: Boolean(schedulerTimer),
    startedAt: schedulerState.startedAt,
    intervalMs: schedulerState.intervalMs,
    venue: schedulerState.venue,
    initialDelayMs: schedulerState.initialDelayMs,
    initialRunScheduled: schedulerState.initialRunScheduled,
    lastRunAt: schedulerState.lastRunAt,
    lastRunStatus: schedulerState.lastRunStatus,
    lastError: schedulerState.lastError,
    lastProgressAt: schedulerState.lastProgressAt,
    lastProgress: schedulerState.lastProgress,
    lastSignalCounts: schedulerState.lastSignalCounts,
    lastScanDiagnostics: schedulerState.lastScanDiagnostics,
  };
}

function stopScheduler() {
  const wasRunning = Boolean(schedulerTimer || schedulerStartTimer);
  if (schedulerStartTimer) {
    clearTimeout(schedulerStartTimer);
    schedulerStartTimer = null;
  }
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerState = { ...schedulerState, initialRunScheduled: false };
  return wasRunning;
}

function startScheduler({
  bot,
  chatId,
  intervalMs = 4 * 60 * 60 * 1000,
  initialDelayMs = Number(process.env.PERPSIA_SCHEDULER_INITIAL_DELAY_MS || 30000),
  venue,
}) {
  if (!bot) {
    throw new Error("Scheduler requires bot instance.");
  }

  if (!chatId) {
    schedulerState = {
      ...schedulerState,
      configured: false,
      intervalMs,
      venue: venue || null,
      initialDelayMs: null,
      initialRunScheduled: false,
    };
    console.log("Scheduler not started: TELEGRAM_CHAT_ID missing.");
    return { started: false, reason: "missing_chat_id" };
  }

  if (schedulerTimer) {
    console.log("Scheduler already started in this process.");
    return { started: false, reason: "already_started", stop: stopScheduler };
  }

  const parsedInitialDelayMs = Number(initialDelayMs);
  const safeInitialDelayMs = Math.min(
    Math.max(Number.isFinite(parsedInitialDelayMs) ? parsedInitialDelayMs : 30000, 0),
    5 * 60 * 1000
  );

  console.log(
    `Perpsia smart alert scheduler started. Initial scan in ${safeInitialDelayMs}ms; interval: ${intervalMs}ms`
  );
  schedulerState = {
    configured: true,
    startedAt: new Date().toISOString(),
    intervalMs,
    venue: venue || null,
    initialDelayMs: safeInitialDelayMs,
    initialRunScheduled: true,
  };
  schedulerStartTimer = setTimeout(() => {
    schedulerStartTimer = null;
    schedulerState = { ...schedulerState, initialRunScheduled: false };
    void runScheduledScan({ bot, chatId, venue }).catch((error) => {
      console.error("Initial scheduled scan runner failed:", error.message);
    });
  }, safeInitialDelayMs);
  schedulerStartTimer.unref?.();
  schedulerTimer = setInterval(() => {
    void runScheduledScan({ bot, chatId, venue }).catch((error) => {
      console.error("Scheduled scan runner failed:", error.message);
    });
  }, intervalMs);
  schedulerTimer.unref?.();
  return { started: true, stop: stopScheduler };
}

module.exports = {
  startScheduler,
  stopScheduler,
  getSchedulerHealth,
  runScheduledScan,
};
