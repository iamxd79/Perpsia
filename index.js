const crypto = require("crypto");
require("dotenv").config();
















const {
  buildReasoningBrief,
} = require("./services/openaiReasoning");
const { getGrokHealth } = require("./services/grokResearch");
const { getOpenAISignalValidationHealth } = require("./services/openaiSignalValidation");
















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
  normalizeVenue,
} = require("./services/exchangeAdapter");
















// ========== BACKTESTER FOR PAPER TRADING ==========
const { Backtester } = require("./services/backtester");
const backtester = new Backtester();
const {
  closePosition: closePaperPosition,
  formatClosed: formatPaperClosed,
  formatPosition: formatPaperPosition,
  getOpenPositions: getPaperOpenPositions,
  getStats: getPaperStats,
  openPosition: openPaperPosition,
  parsePaperCommand,
  refreshPositions: refreshPaperPositions,
  startPaperTradingMonitor,
} = require("./services/paperTrading");
const { renderPaperClosedCard, renderPaperPnlCard } = require("./services/paperCard");
const { getAdminStats, getAdminUsers, getLeaderboard, getUserStats, isAdmin, markUserStatus, trackUser } = require("./services/userAnalytics");
const { createTelegramLinkSession } = require("./services/accountIdentity");
const {
  consumeTelegramLinkSession,
  getAccountIdentities,
  getOrCreateIdentity,
  inspectTelegramLinkSession,
} = require("./services/accountIdentity");
const { verifyPrivyAccessToken } = require("./services/privyAuth");
const { getPrivyUserWallets } = require("./services/privyAuth");
const { getAccountOverview, saveAccountPreferences, saveAccountRisk } = require("./services/accountData");
const { getUserWallets, linkWallet, unlinkWallet, setPrimaryWallet } = require("./services/wallets");
const { recordAccountAnalysis } = require("./services/accountActivity");
const { getAccountBalance } = require("./services/tokenBalance");
const { getAsset } = require("./services/assetRegistry");
const { getStakingState } = require("./services/staking");
const { getAccountEntitlements } = require("./services/entitlements");
const { getTokenHealth } = require("./services/tokenHealth");
















const {
  saveAssetState,
  getLastAssetState,
  compareAssetState,
  saveRiskSettings,
  getRiskSettings,
  getAssetHistory,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getUserPreferences,
  saveUserPreferences,
  getActiveSignals,
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
  stopScheduler,
  getSchedulerHealth,
} = require("./services/scheduler");
















const {
  lockScan,
  unlockScan,
  lockTelegramPolling,
  refreshTelegramPollingLock,
  unlockTelegramPolling,
} = require("./services/scanLock");
















const {
  getPerformance,
  getPerformanceRows,
  recordSignal: recordPerformanceSignal,
  evaluateSignalOutcomes,
  getSignalQualityReport,
  getSignalQualityHealth,
  getStorageInfo,
} = require("./services/performance");
const {
  recordSignal: recordTelemetrySignal,
  recordScan,
  renderPrometheus,
  setGauge,
  structuredLog,
} = require("./services/telemetry");
const { cmcCircuitBreaker } = require("./services/resilience");


function getPublicScanCandidates() {
  const scheduler = getSchedulerHealth();
  const diagnostics = scheduler?.lastScanDiagnostics;
  const candidates = Array.isArray(diagnostics?.topCandidates) ? diagnostics.topCandidates : [];

  return candidates
    .filter((candidate) => candidate?.hasCoreData && /bullish|bearish|long|short/i.test(String(candidate.direction || "")))
    .map((candidate, index) => {
      const rawDirection = String(candidate.direction || "").toLowerCase();
      const direction = /bearish|short/.test(rawDirection) ? "SHORT" : "LONG";
      const category = String(candidate.category || "").toLowerCase();
      return {
        id: `early-${candidate.symbol || index}-${scheduler.lastRunAt || "scan"}`,
        symbol: candidate.symbol,
        signalType: `${direction} BIAS`,
        direction,
        category: category === "watchlist" ? "watchlist" : "early",
        score: Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : null,
        lifecycleState: "DEVELOPING",
        marketState: "Developing market conditions",
        updatedAt: scheduler.lastRunAt || null,
        reasons: Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 4) : [],
        risks: Array.isArray(candidate.confirmationNeeded) ? candidate.confirmationNeeded.slice(0, 4) : [],
        earlyCandidate: true,
      };
    });
}
function getBuildHealth() {
  return {
    commit: process.env.RENDER_GIT_COMMIT || process.env.RENDER_GIT_COMMIT_SHA || null,
    node: process.version,
    scanLimits: {
      maxCandidates: Number(process.env.PERPSIA_MAX_SCAN_CANDIDATES || 54),
      deepAnalysisCandidates: Number(process.env.PERPSIA_DEEP_ANALYSIS_CANDIDATES || 4),
      aiValidationCandidates: Number(process.env.PERPSIA_AI_VALIDATION_CANDIDATES || 12),
    },
  };
}

function getIntegrationHealth() {
  const has = (name) => Boolean(String(process.env[name] || "").trim());
  return {
    cmc: { configured: has("CMC_MCP_ENDPOINT"), circuit: cmcCircuitBreaker.snapshot() },
    grok: { enabled: process.env.PERPSIA_ENABLE_GROK_RESEARCH === "true", configured: has("XAI_API_KEY"), model: process.env.XAI_MODEL || "grok-4.6", runtime: getGrokHealth() },
    openai: {
      enabled: process.env.PERPSIA_ENABLE_OPENAI_SIGNAL_VALIDATION === "true" || has("OPENAI_API_KEY"),
      configured: has("OPENAI_API_KEY"),
      activation: "default_on_when_configured",
      model: process.env.OPENAI_SIGNAL_MODEL || "gpt-5.5",
      runtime: getOpenAISignalValidationHealth(),
    },
  };
}
const {
  getProviderCatalog,
  getProviderHealth,
} = require("./services/providers/publicProviders");
const { getAlchemyHealth, recordAlchemyWebhook, verifyAlchemySignature } = require("./services/providers/alchemy");
const { getGmgnHealth } = require("./services/providers/gmgn");
const { getAlchemySyncHealth, startAlchemyWatchlistSync, stopAlchemyWatchlistSync } = require("./services/alchemySync");
const { getRegistryHealth } = require("./services/walletRegistry");
const { getWalletRefreshHealth, startWalletRefresh, stopWalletRefresh } = require("./services/walletRefresh");
const { getOnchainStoreHealth } = require("./services/onchainStore");
const { getStreamManager } = require("./services/providers/streamManager");
const { getSnapshotHealth } = require("./services/providers/liveSnapshotStore");
const {
  ABOUT_MESSAGE,
  HELP_MESSAGE,
  WELCOME_MESSAGE,
  formatAlphaCard,
  formatComparison,
  formatErrorState,
  formatHistory,
  formatPerformance,
  formatProgress,
  formatRiskProfile,
  formatScanSummary,
  formatSettings,
  formatSignalCard,
  formatStatus,
  formatWatchlist,
  registerPublicCommands,
  scanSummaryKeyboard,
  settingsKeyboard,
  signalKeyboard,
  startKeyboard,
  watchlistKeyboard,
} = require("./services/telegramUi");
const {
  buildTradingLinksForSignal,
} = require("./services/tradingLinks");
























function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(String.fromCharCode(34), "&quot;");
}








function performanceDashboardHtml(payload) {
  const stats = payload?.last_30_days || {};
  const status = payload?.data_status || "unknown";
  const card = (label, value) =>
    "<div class=\"card\"><span>" + label + "</span><strong>" + escapeHtml(value) + "</strong></div>";








  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>Perpsia Performance</title>",
    "<style>body{font-family:system-ui;background:#0b1220;color:#e5edf7;max-width:960px;margin:0 auto;padding:32px}h1{margin-bottom:6px}.muted{color:#9fb0c5}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:24px 0}.card{background:#162337;border:1px solid #263b55;border-radius:12px;padding:16px}.card span{display:block;color:#9fb0c5;font-size:13px}.card strong{display:block;font-size:25px;margin-top:8px}.ok{color:#6ee7b7}.warn{color:#fbbf24}.method{background:#111c2d;border-radius:12px;padding:16px;line-height:1.5}</style>",
    "</head><body>",
    "<h1>Perpsia Performance Leaderboard</h1>",
    "<p class=\"muted\">30-day paper-signal history · updated " + escapeHtml(payload?.generated_at || "") + "</p>",
    "<p class=\"" + (status === "no_settled_signals" ? "warn" : "ok") + "\">Data status: " + escapeHtml(status) + "</p>",
    "<div class=\"grid\">",
    card("Total signals", stats.total_signals ?? 0),
    card("Closed signals", stats.closed_signals ?? 0),
    card("Open signals", stats.open_signals ?? 0),
    card("Win rate", stats.win_rate ?? "0%"),
    card("Avg win", stats.avg_win ?? "0.00%"),
    card("Avg loss", stats.avg_loss ?? "0.00%"),
    card("Profit factor", stats.profit_factor ?? 0),
    card("Sharpe ratio", stats.sharpe_ratio ?? 0),
    card("Max drawdown", stats.max_drawdown ?? "0.00%"),
    card("Consecutive wins", stats.max_consecutive_wins ?? 0),
    "</div>",
    "<div class=\"method\"><strong>Methodology</strong><p>" + escapeHtml(payload?.methodology || "") + "</p><p>Third-party verification: " + escapeHtml(payload?.verified_by || "Not configured") + "</p></div>",
    "</body></html>",
  ].join("");
}








function readRequestBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorizeInternalRequest(req, res) {
  const expected = String(process.env.PERPSIA_INTERNAL_API_TOKEN || "");
  if (!expected) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Internal endpoint is not configured." }));
    return false;
  }
  const authorization = String(req.headers.authorization || "");
  const provided = authorization.replace(/^Bearer\s+/i, "") || String(req.headers["x-perpsia-internal-token"] || "");
  const matches = provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!matches) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}
async function handleHttpRequest(req, res) {
  const requestUrl = new URL(req.url || "/", "http://perpsia.local");








  try {
    if (requestUrl.pathname === "/webhooks/alchemy") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      const rawBody = await readRequestBody(req);
      const signature = req.headers["x-alchemy-signature"];
      if (!verifyAlchemySignature(rawBody, signature)) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Invalid Alchemy webhook signature" }));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        return;
      }
      const result = recordAlchemyWebhook(payload);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ status: "accepted", provider: "alchemy", ...result }));
      return;
    }

    if (requestUrl.pathname === "/health") {
      const providers = getProviderHealth();
      const streamHealth = getStreamManager().getHealth();
      const snapshots = getSnapshotHealth();
      const degraded = providers.some((item) => ["circuit_open", "offline", "degraded"].includes(String(item.status || "").toLowerCase())) ||
        streamHealth.some((item) => ["degraded", "stale"].includes(String(item.status || "").toLowerCase())) ||
        Number(snapshots.stale || 0) > 0;
      const noProviderAvailable = providers.length > 0 && providers.every((item) => ["circuit_open", "offline"].includes(String(item.status || "").toLowerCase()));
      res.writeHead(noProviderAvailable ? 503 : 200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        status: degraded ? "degraded" : "ok",
        service: "Perpsia Terminal",
        build: getBuildHealth(),
        storage: getStorageInfo(),
        signal_quality: getSignalQualityHealth(),
        scheduler: getSchedulerHealth(),
        integrations: getIntegrationHealth(),
        onchain: {
          storage: getOnchainStoreHealth(),
          alchemy: getAlchemyHealth(),
          gmgn: getGmgnHealth(),
          walletRegistry: getRegistryHealth(),
          alchemySync: getAlchemySyncHealth(),
          walletRefresh: getWalletRefreshHealth(),
          token: getTokenHealth(),
        },
        providers,
        realtime: {
          streams: streamHealth,
          snapshots,
        },
      }));
      return;
    }

    if (requestUrl.pathname === "/metrics") {
      if (!authorizeInternalRequest(req, res)) return;
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(renderPrometheus());
      return;
    }

    if (requestUrl.pathname === "/api/account/link/inspect") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      if (!authorizeInternalRequest(req, res)) return;
      let body;
      try {
        body = JSON.parse(await readRequestBody(req, 32 * 1024));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        return;
      }
      const result = inspectTelegramLinkSession(body?.token);
      res.writeHead(result.status === "valid" ? 200 : 400, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(result));
      return;
    }

    if (requestUrl.pathname === "/api/account/link/consume") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      if (!authorizeInternalRequest(req, res)) return;
      let body;
      try {
        body = JSON.parse(await readRequestBody(req, 64 * 1024));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        return;
      }
      try {
        const verified = await verifyPrivyAccessToken(body?.privyAccessToken);
        const identity = consumeTelegramLinkSession(
          body?.token,
          "privy",
          verified.user_id,
          { sessionId: verified.session_id },
        );
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ accountId: identity.account_id, provider: identity.provider }));
      } catch (error) {
        const conflict = /already linked to another/i.test(error.message);
        const status = error.code === "PRIVY_NOT_CONFIGURED" ? 503 : conflict ? 409 : 401;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: conflict ? "account_conflict" : error.message }));
      }
      return;
    }

    if (requestUrl.pathname === "/api/account/me") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      if (!authorizeInternalRequest(req, res)) return;
      let body;
      try {
        body = JSON.parse(await readRequestBody(req, 32 * 1024));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        return;
      }
      try {
        const verified = await verifyPrivyAccessToken(body?.privyAccessToken);
        const identity = getOrCreateIdentity("privy", verified.user_id, { sessionId: verified.session_id });
        const identities = getAccountIdentities(identity.account_id).map((item) => ({
          provider: item.provider,
          createdAt: item.created_at,
          lastSeenAt: item.last_seen_at,
        }));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ accountId: identity.account_id, identities }));
      } catch (error) {
        const status = error.code === "PRIVY_NOT_CONFIGURED" ? 503 : 401;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (requestUrl.pathname === "/api/account/overview") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      if (!authorizeInternalRequest(req, res)) return;
      let body;
      try { body = JSON.parse(await readRequestBody(req, 32 * 1024)); } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        return;
      }
      try {
        const verified = await verifyPrivyAccessToken(body?.privyAccessToken);
        const identity = getOrCreateIdentity("privy", verified.user_id, { sessionId: verified.session_id });
        const overview = getAccountOverview(identity.account_id);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ...overview, wallets: getUserWallets(identity.account_id) }));
      } catch (error) {
        const status = error.code === "PRIVY_NOT_CONFIGURED" ? 503 : 401;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (requestUrl.pathname === "/api/account/wallets") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      if (!authorizeInternalRequest(req, res)) return;
      let body;
      try { body = JSON.parse(await readRequestBody(req, 32 * 1024)); } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        return;
      }
      try {
        const verified = await verifyPrivyAccessToken(body?.privyAccessToken);
        const identity = getOrCreateIdentity("privy", verified.user_id, { sessionId: verified.session_id });
        let result;
        if (body?.action === "link") {
          const requested = body.wallet && typeof body.wallet === "object" ? body.wallet : {};
          const owned = await getPrivyUserWallets(verified.user_id);
          const target = owned.find((wallet) => String(wallet.address).toLowerCase() === String(requested.address || "").trim().toLowerCase());
          if (!target) {
            const error = new Error("That wallet is not linked to the authenticated Privy user.");
            error.code = "WALLET_NOT_OWNED";
            throw error;
          }
          result = linkWallet(identity.account_id, {
            ...requested,
            ...target,
            chain: requested.chain || { namespace: target.chainType === "solana" ? "solana" : "eip155", id: requested.chain?.id || "1" },
          });
        } else if (body?.action === "set_primary") {
          result = setPrimaryWallet(identity.account_id, body.walletId);
        } else if (body?.action === "unlink") {
          result = unlinkWallet(identity.account_id, body.walletId);
        } else {
          result = getUserWallets(identity.account_id);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ wallets: Array.isArray(result) ? result : getUserWallets(identity.account_id), result: Array.isArray(result) ? undefined : result }));
      } catch (error) {
        const conflict = error.code === "WALLET_ACCOUNT_CONFLICT";
        const ownership = error.code === "WALLET_NOT_OWNED";
        const notConfigured = ["PRIVY_NOT_CONFIGURED", "PRIVY_SERVER_NOT_CONFIGURED"].includes(error.code);
        const status = notConfigured ? 503 : conflict ? 409 : ownership ? 403 : error.code === "INVALID_PRIVY_TOKEN" ? 401 : 400;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: conflict ? "wallet_account_conflict" : ownership ? "wallet_not_owned" : error.message }));
      }
      return;
    }

    if (requestUrl.pathname === "/api/account/token") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      if (!authorizeInternalRequest(req, res)) return;
      let body;
      try { body = JSON.parse(await readRequestBody(req, 32 * 1024)); } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        return;
      }
      try {
        const verified = await verifyPrivyAccessToken(body?.privyAccessToken);
        const identity = getOrCreateIdentity("privy", verified.user_id, { sessionId: verified.session_id });
        const asset = getAsset("PERPSIA");
        const [balance, staking] = await Promise.all([getAccountBalance(identity.account_id, asset), Promise.resolve(getStakingState(identity.account_id, asset.symbol))]);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ asset, balance, staking, entitlements: getAccountEntitlements(identity.account_id) }));
      } catch (error) {
        const status = error.code === "PRIVY_NOT_CONFIGURED" ? 503 : error.code === "INVALID_PRIVY_TOKEN" ? 401 : 400;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (requestUrl.pathname === "/api/account/preferences" || requestUrl.pathname === "/api/account/risk") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      if (!authorizeInternalRequest(req, res)) return;
      let body;
      try { body = JSON.parse(await readRequestBody(req, 32 * 1024)); } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Invalid JSON payload" }));
        return;
      }
      try {
        const verified = await verifyPrivyAccessToken(body?.privyAccessToken);
        const identity = getOrCreateIdentity("privy", verified.user_id, { sessionId: verified.session_id });
        if (requestUrl.pathname.endsWith("/preferences")) {
          saveAccountPreferences(identity.account_id, body.preferences || {});
        } else {
          const values = [body.risk?.capital, body.risk?.riskPercent ?? body.risk?.risk_percent, body.risk?.maxLeverage ?? body.risk?.max_leverage].map(Number);
          if (values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("Valid capital, risk percentage, and leverage are required.");
          saveAccountRisk(identity.account_id, ...values);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(getAccountOverview(identity.account_id)));
      } catch (error) {
        const status = error.code === "PRIVY_NOT_CONFIGURED" ? 503 : error.code === "INVALID_PRIVY_TOKEN" ? 401 : 400;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }








    if (requestUrl.pathname === "/api/signals") {
      const rawDays = Number(requestUrl.searchParams.get("days") || 2);
      const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 1), 30) : 2;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const signals = getActiveSignals(200).filter((signal) => {
        const timestamp = Date.parse(signal.updatedAt || "");
        return !Number.isFinite(timestamp) || timestamp >= cutoff;
      });
      const timestamps = signals.map((signal) => Date.parse(signal.updatedAt || "")).filter(Number.isFinite);
      const updatedAt = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
      const schedulerHealth = getSchedulerHealth();
      const candidates = getPublicScanCandidates();
      const candidateUpdatedAt = schedulerHealth?.lastRunAt || null;
      const feedUpdatedAt = updatedAt || candidateUpdatedAt;
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=15, s-maxage=15, stale-while-revalidate=30",
      });
      res.end(JSON.stringify({
        signals,
        candidates,
        meta: {
          source: "active-signals-and-early-candidates",
          updatedAt: feedUpdatedAt,
          stale: feedUpdatedAt ? Date.now() - Date.parse(feedUpdatedAt) > 6 * 60 * 60 * 1000 : false,
        },
      }));
      return;
    }
    if (requestUrl.pathname === "/api/signal-quality" || requestUrl.pathname === "/api/performance/quality") {
      if (!authorizeInternalRequest(req, res)) return;
      const rawDays = Number(requestUrl.searchParams.get("days") || 365);
      const rawHorizon = requestUrl.searchParams.get("horizon") || "24h";
      const rawSettle = requestUrl.searchParams.get("settle");
      const evaluation = rawSettle === "0" || rawSettle === "false"
        ? { considered: 0, evaluated: 0, pending: 0, noData: 0, errors: [] }
        : await evaluateSignalOutcomes({
            lookbackDays: Number.isFinite(rawDays) ? rawDays : 365,
            limit: 100,
          });
      const payload = getSignalQualityReport({
        lookbackDays: Number.isFinite(rawDays) ? rawDays : 365,
        horizon: rawHorizon,
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": process.env.PERFORMANCE_CORS_ORIGIN || "https://perpsia.app",
      });
      res.end(JSON.stringify({ ...payload, evaluation }));
      return;
    }

    if (requestUrl.pathname === "/api/performance") {
      const rawDays = Number(requestUrl.searchParams.get("days") || 30);
      const rawSettle = requestUrl.searchParams.get("settle");
      const payload = await getPerformance({
        lookbackDays: Number.isFinite(rawDays) ? rawDays : 30,
        settle: rawSettle !== "0" && rawSettle !== "false",
      });
      setGauge("perpsia_open_signals", payload.last_30_days.open_signals);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": process.env.PERFORMANCE_CORS_ORIGIN || "https://perpsia.app",
      });
      res.end(JSON.stringify(payload));
      return;
    }








    if (requestUrl.pathname === "/api/performance/trades") {
      if (!authorizeInternalRequest(req, res)) return;
      const rawDays = Number(requestUrl.searchParams.get("days") || 30);
      const rows = getPerformanceRows({
        lookbackDays: Number.isFinite(rawDays) ? rawDays : 30,
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": process.env.PERFORMANCE_CORS_ORIGIN || "https://perpsia.app",
      });
      res.end(JSON.stringify({ trades: rows }));
      return;
    }








    if (requestUrl.pathname === "/performance") {
      const payload = await getPerformance({ lookbackDays: 30 });
      setGauge("perpsia_open_signals", payload.last_30_days.open_signals);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(performanceDashboardHtml(payload));
      return;
    }








    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        status: "online",
        service: "Perpsia Terminal",
        version: "2.1.0-observable",
        features: [
          "live-cmc-integration",
          "multi-exchange",
          "request-queue",
          "backtester-ready",
          "public-onchain-whales",
          "alchemy-onchain-evidence",
          "gmgn-read-only-intelligence",
          "correlation-analysis",
          "performance-leaderboard",
          "resilience-retries-circuit-breaker",
          "prometheus-metrics",
          "multi-source-evidence",
          "public-cex-derivatives",
          "public-dex-discovery",
          "public-websocket-streams",
        ],
        endpoints: {
          active_signals: "/api/signals",
          performance: "/api/performance",
          dashboard: "/performance",
          metrics: "/metrics",
          performance_trades: "/api/performance/trades",
          signal_quality: "/api/signal-quality",
          health: "/health",
          alchemy_webhook: "/webhooks/alchemy",
        },
        circuit_breaker: cmcCircuitBreaker.snapshot(),
        integrations: getIntegrationHealth(),
        storage: getStorageInfo(),
        signal_quality: getSignalQualityHealth(),
        scheduler: getSchedulerHealth(),
        onchain: {
          storage: getOnchainStoreHealth(),
          alchemy: getAlchemyHealth(),
          gmgn: getGmgnHealth(),
          walletRegistry: getRegistryHealth(),
          alchemySync: getAlchemySyncHealth(),
          walletRefresh: getWalletRefreshHealth(),
        },
        providers: {
          catalog: getProviderCatalog(),
          health: getProviderHealth(),
        },
        realtime: {
          streams: getStreamManager().getHealth(),
          snapshots: getSnapshotHealth(),
        },
      })
    );
  } catch (error) {
    structuredLog("error", "http_request_failed", {
      path: requestUrl.pathname,
      message: error.message,
    });
    res.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({
      status: "degraded",
      error: "The requested report is temporarily unavailable.",
    }));
  }
}
























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
















let pollingRetryTimer = null;
let pollingRetryAttempt = 0;
let pollingRestarting = false;
let commandsRegistered = false;
let telegramLockHeld = false;
let telegramLockRenewalTimer = null;




function isTelegramPollingConflict(error) {
  return (
    error?.response?.body?.error_code === 409 ||
    /409 Conflict|terminated by other getUpdates request/i.test(error?.message || "")
  );
}




function scheduleTelegramPollingRetry() {
  if (pollingRetryTimer) return;
  const delay = Math.min(60000, 10000 * Math.pow(2, pollingRetryAttempt));
  pollingRetryAttempt = Math.min(pollingRetryAttempt + 1, 3);
  console.error(
    "Telegram polling conflict; retrying in " + Math.round(delay / 1000) + "s."
  );
  pollingRetryTimer = setTimeout(() => {
    pollingRetryTimer = null;
    void startTelegramPolling();
  }, delay);
}




function startTelegramLockRenewal() {
  if (telegramLockRenewalTimer) return;
  telegramLockRenewalTimer = setInterval(() => {
    if (!refreshTelegramPollingLock()) {
      console.error("Telegram polling lock could not be renewed.");
      void Promise.resolve(bot.stopPolling?.()).catch(() => {});
      releaseTelegramPollingLock();
      scheduleTelegramPollingRetry();
    }
  }, 30000);
  telegramLockRenewalTimer.unref?.();
}

function releaseTelegramPollingLock() {
  if (telegramLockRenewalTimer) {
    clearInterval(telegramLockRenewalTimer);
    telegramLockRenewalTimer = null;
  }
  if (telegramLockHeld) {
    unlockTelegramPolling();
    telegramLockHeld = false;
  }
}

function clearTelegramPollingRetry() {
  if (pollingRetryTimer) {
    clearTimeout(pollingRetryTimer);
    pollingRetryTimer = null;
  }
}

async function startTelegramPolling() {
  if (pollingRestarting) return;
  if (!lockTelegramPolling()) {
    console.error("Telegram polling not started: another process owns the bot token.");
    scheduleTelegramPollingRetry();
    return;
  }
  telegramLockHeld = true;
  pollingRestarting = true;

  try {
    if (!commandsRegistered) {
      try {
        await registerPublicCommands(bot);
        commandsRegistered = true;
        console.log("Telegram command menu registered.");
      } catch (error) {
        console.error("Telegram command registration failed:", error?.message || error);
      }
    }
    await bot.startPolling();
    startTelegramLockRenewal();
    pollingRetryAttempt = 0;
    console.log("Telegram polling started.");
  } catch (error) {
    releaseTelegramPollingLock();
    if (isTelegramPollingConflict(error)) {
      scheduleTelegramPollingRetry();
    } else {
      console.error("Telegram polling failed to start:", error.message);
      process.exitCode = 1;
    }
  } finally {
    pollingRestarting = false;
  }
}


bot.on("polling_error", (error) => {
  if (isTelegramPollingConflict(error)) {
    console.error(
      "Telegram polling conflict: another process currently owns this bot token."
    );
    void bot.stopPolling().catch(() => {});
    releaseTelegramPollingLock();
    scheduleTelegramPollingRetry();
    return;
  }

  console.error("Telegram polling error:", error?.message || error);
});












// ==========================================
// GLOBAL LOCKS
// ==========================================
















let isAnalyzeRunning = false;
const latestScansByChat = new Map();
const MAX_LATEST_SCANS = 500;

function rememberLatestScan(chatId, value) {
  const key = String(chatId);
  latestScansByChat.delete(key);
  latestScansByChat.set(key, { ...value, savedAt: Date.now() });
  while (latestScansByChat.size > MAX_LATEST_SCANS) {
    latestScansByChat.delete(latestScansByChat.keys().next().value);
  }
}
















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
















async function safeEditMessage(chatId, messageId, text, options = {}) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options,
    });
  } catch {}
}
















// ==========================================
// FORMAT SCAN RESULT (v2)
// ==========================================
















function formatLiquidationFlow(flow) {
  if (!flow || flow.status !== "available") return "";
















  const risk = String(flow.cascadeRisk || "NONE").replaceAll("_", " ");
  const lines = [
    "🔥 LIQUIDATION FLOW",
    "Risk: " + risk,
  ];
















  if (Array.isArray(flow.reasons) && flow.reasons.length) {
    lines.push(...flow.reasons.slice(0, 3).map((reason) => "• " + reason));
  }
















  if (Array.isArray(flow.recentLiqs) && flow.recentLiqs.length) {
    lines.push("Recent liquidation events: " + flow.recentLiqs.length);
  }
















  return lines.join(String.fromCharCode(10));
}
















function formatDivergenceReport(divergences) {
  const list = Array.isArray(divergences) ? divergences : [];
  const lines = ["⚠️ DIVERGENCES"];
















  if (!list.length) {
    lines.push("No material momentum divergence detected.");
    return lines.join(String.fromCharCode(10));
  }
















  for (const divergence of list.slice(0, 5)) {
    const severity = String(divergence.severity || "INFO").toUpperCase();
    const message = String(divergence.message || divergence.type || "Divergence detected.");
    const adjustment = Number.isFinite(divergence.scoreAdjust)
      ? " (" + (divergence.scoreAdjust > 0 ? "+" : "") + divergence.scoreAdjust + " score)"
      : "";
















    lines.push("• [" + severity + "] " + message + adjustment);
  }
















  return lines.join(String.fromCharCode(10));
}
















function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  if (number >= 1000000000) return (number / 1000000000).toFixed(1) + "B";
  if (number >= 1000000) return (number / 1000000).toFixed(1) + "M";
  if (number >= 1000) return (number / 1000).toFixed(1) + "K";
  return number.toFixed(0);
}
















function formatWhaleActivity(activity) {
  if (!activity || activity.status !== "available") return "";
















  const lines = [
    "🐋 WHALE ACTIVITY",
    activity.summary || "Large-holder transfer activity detected.",
  ];
















  if (activity.volumeToExchanges > 0) {
    lines.push("To exchanges: $" + formatUsd(activity.volumeToExchanges));
  }
















  if (activity.volumeFromExchanges > 0) {
    lines.push("From exchanges: $" + formatUsd(activity.volumeFromExchanges));
  }
















  if (activity.largestMove?.valueUsd > 0) {
    lines.push(
      "Largest transfer: $" +
        formatUsd(activity.largestMove.valueUsd) +
        " (" +
        String(activity.largestMove.transferType || "TRANSFER").replaceAll("_", " ") +
        ")"
    );
  }
















  return lines.join(String.fromCharCode(10));
}
































function formatCorrelationReport(correlation) {
  if (!correlation || correlation.status !== "available") return "";
















  const formatPairs = (pairs) =>
    (Array.isArray(pairs) ? pairs : [])
      .slice(0, 4)
      .map(
        (pair) =>
          String(pair.symbol || "ASSET") +
          " (" +
          Number(pair.correlation || 0).toFixed(2) +
          ")"
      )
      .join(", ");
















  const lines = [
    "🧭 CORRELATION ANALYSIS",
    correlation.rationale || "Cross-asset context available.",
  ];
















  if (correlation.supportive?.length) {
    lines.push("Supportive: " + formatPairs(correlation.supportive));
  }
















  if (correlation.headwinds?.length) {
    lines.push("Headwinds: " + formatPairs(correlation.headwinds));
  }
















  if (correlation.freshnessNote) {
    lines.push("Data window: " + correlation.freshnessNote);
  }
















  return lines.join(String.fromCharCode(10));
}
































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
















  const liquidationSignals = [
    ...result.longs,
    ...result.shorts,
    ...result.watchlist,
    ...result.neutral,
  ].filter(
    (signal) =>
      signal.liquidationFlow?.status === "available" &&
      signal.liquidationFlow.cascadeRisk !== "NONE"
  );
















  if (liquidationSignals.length > 0) {
    output += "\n🔥 LIQUIDATION FLOW\n\n";
















    liquidationSignals.slice(0, 5).forEach((signal) => {
      const flow = signal.liquidationFlow;
      const reason = flow.reasons?.[0] || "Directional liquidation risk detected.";
      output +=
        "$" +
        signal.symbol +
        " — " +
        String(flow.cascadeRisk).replaceAll("_", " ") +
        "\n" +
        reason +
        "\n\n";
    });
  }
















  const divergenceSignals = [
    ...result.longs,
    ...result.shorts,
    ...result.watchlist,
    ...result.neutral,
  ].filter((signal) => Array.isArray(signal.divergences) && signal.divergences.length);
















  output += "\n⚠️ DIVERGENCES\n\n";
















  if (!divergenceSignals.length) {
    output += "No material momentum divergence detected.\n\n";
  } else {
    divergenceSignals.slice(0, 5).forEach((signal) => {
      output += "$" + signal.symbol + "\n";
      output += signal.divergences
        .slice(0, 3)
        .map((divergence) =>
          "• [" +
          String(divergence.severity || "INFO").toUpperCase() +
          "] " +
          String(divergence.message || divergence.type)
        )
        .join("\n");
      output += "\n\n";
    });
  }
































  const whaleSignals = [
    ...result.longs,
    ...result.shorts,
    ...result.watchlist,
    ...result.neutral,
  ].filter((signal) => signal.whaleActivity?.status === "available");
















  if (whaleSignals.length > 0) {
    output += "\n🐋 WHALE ACTIVITY\n\n";
















    whaleSignals.slice(0, 5).forEach((signal) => {
      const activity = signal.whaleActivity;
      output += "$" + signal.symbol + "\n";
      output += (activity.summary || "Large-holder transfer activity detected.") + "\n";
















      if (activity.volumeToExchanges > 0) {
        output += "To exchanges: $" + formatUsd(activity.volumeToExchanges) + "\n";
      }
















      if (activity.volumeFromExchanges > 0) {
        output += "From exchanges: $" + formatUsd(activity.volumeFromExchanges) + "\n";
      }
















      output += "\n";
    });
  }
































  const correlationSignals = [
    ...result.longs,
    ...result.shorts,
    ...result.watchlist,
    ...result.neutral,
  ].filter(
    (signal) =>
      signal.correlation?.status === "available" &&
      signal.correlation.pairs?.length
  );
















  if (correlationSignals.length > 0) {
    output += "\n🧭 CORRELATION CONTEXT\n\n";
















    correlationSignals.slice(0, 5).forEach((signal) => {
      const correlation = signal.correlation;
      output += "$" + signal.symbol + "\n";
      output +=
        (correlation.rationale || "Cross-asset context available.") + "\n";
















      if (correlation.supportive?.length) {
        output +=
          "Supportive links: " +
          correlation.supportive
            .slice(0, 4)
            .map(
              (pair) =>
                String(pair.symbol) +
                " (" +
                Number(pair.correlation || 0).toFixed(2) +
                ")"
            )
            .join(", ") +
          "\n";
      }
















      if (correlation.headwinds?.length) {
        output +=
          "Headwind links: " +
          correlation.headwinds
            .slice(0, 4)
            .map(
              (pair) =>
                String(pair.symbol) +
                " (" +
                Number(pair.correlation || 0).toFixed(2) +
                ")"
            )
            .join(", ") +
          "\n";
      }
















      output += "\n";
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
















function formatBacktestResult(result) {
  if (!result || result.status === "error") {
    return "❌ BACKTEST FAILED" + String.fromCharCode(10) + String.fromCharCode(10) + (result?.message || "No historical data available.");
  }
















  const stats = result.stats || {};
  const formatPercent = (value) => Number.isFinite(value) ? Number(value).toFixed(2) + "%" : "N/A";
  const profitFactor = stats.profitFactor === null ? "∞" : Number.isFinite(stats.profitFactor) ? Number(stats.profitFactor).toFixed(2) : "N/A";
  const start = result.dateRange?.start ? new Date(result.dateRange.start).toISOString().slice(0, 10) : "N/A";
  const end = result.dateRange?.end ? new Date(result.dateRange.end).toISOString().slice(0, 10) : "N/A";
















  const lines = [
    "📊 PERPSIA PAPER BACKTEST — $" + result.symbol,
    "",
    "Range: " + start + " to " + end,
    "Candles replayed: " + (result.candleCount || 0),
    "Status: " + String(result.status || "unknown").toUpperCase(),
    "",
    "Trades: " + stats.totalTrades,
    "Winners: " + stats.winners,
    "Losers: " + stats.losers,
    "Win rate: " + formatPercent(stats.winRate),
    "Avg win: " + formatPercent(stats.avgWin),
    "Avg loss: " + formatPercent(stats.avgLoss),
    "Profit factor: " + profitFactor,
    "Max drawdown: " + formatPercent(stats.maxDrawdown),
    "Total return: " + formatPercent(stats.totalReturn),
  ];
















  if (result.dataQuality?.errors?.length) {
    lines.push("", "⚠️ Data quality: " + result.dataQuality.errors.join("; "));
  }
















  lines.push("", "Paper trading only. No live orders were placed.");
  return lines.join(String.fromCharCode(10));
}
















// ==========================================
// START COMMAND
// ==========================================
















function getHelpMessage() {
  return HELP_MESSAGE;
}
















bot.onText(/^\/start(?:@\w+)?$/i, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    WELCOME_MESSAGE,
    {
      reply_markup: startKeyboard(),
    }
  );
});
















// ==========================================
// HELP COMMAND
// ==========================================
















bot.onText(/^\/help(?:@\w+)?$/i, async (msg) => {
  await bot.sendMessage(msg.chat.id, getHelpMessage());
});


async function sendPaperClosedCard(chatId, position) {
  try {
    const image = await renderPaperClosedCard(position);
    return bot.sendPhoto(chatId, image, { caption: "Paper trade closed · " + position.symbol });
  } catch (error) {
    console.error("Closed paper card render failed:", error.message);
    return bot.sendMessage(chatId, formatPaperClosed(position));
  }
}
async function sendPaperCard(chatId, position, messageId = null) {
  const options = paperPositionKeyboard(position.id);
  try {
    const image = await renderPaperPnlCard(position);
    if (messageId) await bot.deleteMessage(chatId, messageId).catch(() => {});
    return bot.sendPhoto(chatId, image, { caption: "Live paper PnL · " + position.symbol, ...options });
  } catch (error) {
    console.error("Paper PnL card render failed:", error.message);
    return bot.sendMessage(chatId, formatPaperPosition(position), options);
  }
}
function paperPositionKeyboard(positionId) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: "🔄 Refresh PnL", callback_data: "paper_refresh:" + positionId, style: "primary" },
        { text: "✕ Close Position", callback_data: "paper_close:" + positionId, style: "danger" },
      ]],
    },
  };
}
function formatPrivateStats(chatId) {
  const stats = getUserStats(chatId);
  return [
    "MY PAPER PERFORMANCE",
    "",
    "Open positions: " + stats.open,
    "Closed trades: " + stats.closed,
    "Wins / losses: " + stats.wins + " / " + stats.losses,
    "Win rate: " + stats.winRate.toFixed(1) + "%",
    "Realized PnL: " + (stats.realized >= 0 ? "+" : "") + "$" + stats.realized.toFixed(2),
    "",
    "Only you can see these statistics.",
  ].join("\n");
}

function requireAdmin(chatId) {
  if (!isAdmin(chatId)) {
    void bot.sendMessage(chatId, "⛔ Private admin command.");
    return false;
  }
  return true;
}
function paperHelp() {
  return [
    "PAPER TRADING (SIMULATION ONLY)",
    "",
    "/paper long BTCUSDT 1000 5 sl=62000 tp=65000",
    "Direction, symbol, margin, leverage, then optional SL and TP.",
    "",
    "Manage: /paper positions · /paper close BTCUSDT · /paper stats",
    "Prices use public exchange data. No real orders are sent.",
  ].join("\n");
}

async function handlePaperRequest(chatId, request) {
  if (!request || request.action === "help") return bot.sendMessage(chatId, paperHelp());
  if (request.action === "open") {
    try {
      const position = await openPaperPosition(chatId, request);
      return sendPaperCard(chatId, position);
    } catch (error) {
      return bot.sendMessage(chatId, "PAPER TRADE NOT OPENED\n\n" + error.message + "\n\n" + paperHelp());
    }
  }
  if (request.action === "positions") {
    const result = await refreshPaperPositions(chatId);
    const positions = [...result.updated, ...result.closed];
    if (!positions.length) return bot.sendMessage(chatId, "PAPER POSITIONS\n\nNo open paper positions.");
    for (const position of positions) {
      if (result.closed.includes(position)) {
        await bot.sendMessage(chatId, formatPaperClosed(position));
      } else {
        await sendPaperCard(chatId, position);
      }
    }
    return;
  }
  if (request.action === "stats") {
    const stats = await getPaperStats(chatId);
    return bot.sendMessage(chatId, [
      "PAPER PERFORMANCE",
      "",
      "Open positions: " + stats.open.length,
      "Closed trades: " + stats.totalClosed,
      "Wins / losses: " + stats.wins + " / " + stats.losses,
      "Realized PnL: " + (stats.realized >= 0 ? "+" : "") + "$" + stats.realized.toFixed(2),
      "Unrealized PnL: " + (stats.unrealized >= 0 ? "+" : "") + "$" + stats.unrealized.toFixed(2),
      "",
      "Simulation only — this does not place real orders.",
    ].join("\n"));
  }
  if (request.action === "close") {
    const positions = getPaperOpenPositions(chatId);
    const position = request.symbol ? positions.find((item) => item.symbol === request.symbol) : positions[0];
    if (!position) return bot.sendMessage(chatId, "No matching open paper position.");
    const refreshed = await refreshPaperPositions(chatId);
    const current = refreshed.updated.find((item) => item.id === position.id) || position;
    const closed = closePaperPosition(current.id, current.mark_price, "MANUAL");
    return sendPaperClosedCard(chatId, closed);
  }
}function preferredVenue(chatId, fallback = "Binance") {
  const requested = getUserPreferences(chatId)?.preferred_exchange || fallback;
  try {
    return normalizeVenue(requested);
  } catch {
    return fallback;
  }
}


function allScanSignals(result = {}) {
  return [
    ...(result.longs || []),
    ...(result.shorts || []),
    ...(result.watchlist || []),
    ...(result.neutral || []),
  ];
}


function attachSignalLifecycle(signal) {
  const previous = getLastAssetState(signal.symbol);
  const lifecycle = getLifecycleStage(signal, previous);
  signal.lifecycleStage = lifecycle.stage;
  return { previous, lifecycle };
}


function storeSignal(signal, source) {
  saveAssetState(signal);
  recordTelemetrySignal(signal);
  recordPerformanceSignal(signal, source);
}


function signalReplyMarkup(signal, options = {}) {
  return signalKeyboard(
    signal,
    buildTradingLinksForSignal(signal),
    options
  );
}


async function showRiskProfile(chatId) {
  return bot.sendMessage(chatId, formatRiskProfile(getRiskSettings(chatId)));
}


async function updateRiskProfile(chatId, capital, riskPercent, maxLeverage) {
  const values = [capital, riskPercent, maxLeverage].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return bot.sendMessage(chatId, "RISK PROFILE\n\nUse /risk 500 1 5\n\nCapital $500 · Risk 1% · Max leverage 5x");
  }
  saveRiskSettings(chatId, values[0], values[1], values[2]);
  return showRiskProfile(chatId);
}


async function showWatchlist(chatId, messageId = null) {
  const entries = getWatchlist(chatId);
  const text = formatWatchlist(entries);
  const options = { reply_markup: watchlistKeyboard(entries, preferredVenue(chatId)) };
  if (messageId) return safeEditMessage(chatId, messageId, text, options);
  return bot.sendMessage(chatId, text, options);
}


async function changeWatchlist(chatId, action, symbol, messageId = null) {
  if (action === "add") addToWatchlist(chatId, symbol);
  else removeFromWatchlist(chatId, symbol);
  return showWatchlist(chatId, messageId);
}


async function showSettings(chatId, messageId = null) {
  const preferences = getUserPreferences(chatId);
  const entries = getWatchlist(chatId);
  const text = formatSettings(preferences, entries.length, getRiskSettings(chatId));
  const options = { reply_markup: settingsKeyboard() };
  if (messageId) return safeEditMessage(chatId, messageId, text, options);
  return bot.sendMessage(chatId, text, options);
}


async function runHistory(chatId, symbol) {
  const asset = String(symbol || "").replace(/^\$/, "").toUpperCase();
  if (!asset) return bot.sendMessage(chatId, "Use /history BTC");
  return bot.sendMessage(chatId, formatHistory(asset, getAssetHistory(asset, 8)));
}


async function runPerformanceReport(chatId) {
  try {
    return bot.sendMessage(chatId, formatPerformance(getSignalQualityReport({ horizon: "24h" })));
  } catch (error) {
    console.error("Performance report failed:", error);
    return bot.sendMessage(chatId, formatErrorState("Performance unavailable", error));
  }
}


async function showUserStatus(chatId) {
  const providerHealth = getProviderHealth();
  const providersOnline = !providerHealth.some((item) =>
    ["circuit_open", "offline"].includes(String(item?.status || "").toLowerCase())
  );
  return bot.sendMessage(chatId, formatStatus({
    providersOnline,
    databasePersistent: Boolean(getStorageInfo().persistent),
    schedulerOnline: Boolean(autonomousChatId),
  }));
}


function renderScanProgress(progress, tracker, options = {}) {
  const candidateMatch = String(progress?.message || "").match(/(\d+)\s+candidates?/i);
  if (candidateMatch) tracker.total = Number(candidateMatch[1]);
  const symbolMatch = String(progress?.stage || "").match(/^\$([A-Z0-9]+)/i);
  if (symbolMatch) tracker.seen.add(symbolMatch[1].toUpperCase());
  return formatProgress({
    kind: options.kind || "scan",
    symbol: options.symbol,
    venue: options.venue,
    percent: progress?.percent,
    stage: progress?.stage,
    current: tracker.seen.size,
    total: tracker.total,
  });
}


async function runComparison(chatId, leftSymbol, rightSymbol, venue = "Binance") {
  const left = String(leftSymbol || "").replace(/^\$/, "").toUpperCase();
  const right = String(rightSymbol || "").replace(/^\$/, "").toUpperCase();
  if (!left || !right) return bot.sendMessage(chatId, "Use /compare SOL ETH");
  venue = normalizeVenue(venue || preferredVenue(chatId));
  const loading = await bot.sendMessage(chatId, formatProgress({ kind: "analysis", symbol: left + " vs " + right, venue, percent: 5 }));

  try {
    const results = [];
    for (let index = 0; index < 2; index++) {
      const symbol = index === 0 ? left : right;
      const result = await analyzeAsset(symbol, venue, async (progress) => {
        const scaled = index === 0
          ? 5 + Math.round((Number(progress.percent) || 0) * 0.43)
          : 52 + Math.round((Number(progress.percent) || 0) * 0.43);
        await safeEditMessage(chatId, loading.message_id, formatProgress({ kind: "analysis", symbol: left + " vs " + right, venue, percent: scaled, stage: progress.stage }));
      });
      const { lifecycle } = attachSignalLifecycle(result);
      result.lifecycleStage = lifecycle.stage;
      storeSignal(result, "comparison");
      results.push(result);
    }
    recordScan("comparison", "success");
    return safeEditMessage(chatId, loading.message_id, formatComparison(results[0], results[1]));
  } catch (error) {
    console.error("Comparison failed:", error);
    recordScan("comparison", "error");
    return safeEditMessage(chatId, loading.message_id, formatErrorState("Comparison unavailable", error));
  }
}


async function showScanBucket(chatId, messageId, bucket) {
  const latest = latestScansByChat.get(String(chatId));
  if (!latest) return bot.sendMessage(chatId, "No recent scan is available. Use /scan first.");
  const signals = bucket === "watchlist"
    ? latest.result.watchlist || []
    : [...(latest.result.longs || []), ...(latest.result.shorts || [])].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  if (!signals.length) {
    return safeEditMessage(chatId, messageId, bucket === "watchlist" ? "WATCHLIST\n\nNo watchlist setups met the current rules." : "TOP SETUPS\n\nNo actionable setups met the current rules.", { reply_markup: scanSummaryKeyboard(latest.venue) });
  }
  const selected = signals.slice(0, 3);
  const text = [bucket === "watchlist" ? "CURRENT WATCHLIST" : "TOP SETUPS", "", ...selected.map((signal) => formatSignalCard(signal))].join("\n\n");
  const rows = [];
  for (const signal of selected) rows.push(...signalReplyMarkup(signal, { venue: latest.venue }).inline_keyboard);
  rows.push([{ text: "↩ Back to Summary", callback_data: "scan_view:summary", style: "primary" }]);
  return safeEditMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
}
















bot.onText(/^\/backtest(?:@\w+)?(?:\s+([A-Za-z0-9$_-]+))?(?:\s+([0-9]+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1] || "BTC";
  const requestedDays = Number(match[2] || 90);
















  if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 365) {
    return bot.sendMessage(chatId, "Use /backtest BTC [days] with days between 1 and 365.");
  }
















  const endDate = Date.now();
  const startDate = endDate - requestedDays * 24 * 60 * 60 * 1000;
  const loading = await bot.sendMessage(
    chatId,
    "⏳ PERPSIA PAPER BACKTEST" + String.fromCharCode(10) + String.fromCharCode(10) +
      "Fetching " + requestedDays + " days of Binance futures data for $" + symbol + "...",
  );
















  try {
    const result = await backtester.backtest(symbol, startDate, endDate, {
      onProgress: async (progress) => {
        await safeEditMessage(
          chatId,
          loading.message_id,
          "⏳ PERPSIA PAPER BACKTEST" + String.fromCharCode(10) + String.fromCharCode(10) +
            progress.message,
        );
      },
    });
















    await safeEditMessage(chatId, loading.message_id, formatBacktestResult(result));
  } catch (error) {
    console.error("Paper backtest failed:", error);
    await safeEditMessage(
      chatId,
      loading.message_id,
      "❌ BACKTEST FAILED" + String.fromCharCode(10) + String.fromCharCode(10) + error.message,
    );
  }
});
















// ==========================================
// RISK SETTINGS COMMAND
// ==========================================
















bot.onText(
  /^\/risk(?:@\w+)?(?:\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+))?$/i,
  async (msg, match) => {
    const chatId = msg.chat.id;

    if (!match[1]) return showRiskProfile(chatId);
















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
















    return showRiskProfile(chatId);
  }
);
















// ==========================================
// MARKET SCAN RUNNER (v2 - LIVE CMC)
// ==========================================
















async function runManualScan(chatId, venue = "Binance") {
  venue = normalizeVenue(venue);
















  if (!lockScan()) {
    return bot.sendMessage(
      chatId,
      "PERPSIA SCAN IN PROGRESS\n\nAnother market scan is already running. Please wait for it to finish."
    );
  }
















  const loading = await bot.sendMessage(
    chatId,
    formatProgress({ kind: "scan", venue, percent: 5 })
  );

  const progressTracker = { seen: new Set(), total: null };
















  try {
    const result = await runMarketScan(venue, async (progress) => {
      await safeEditMessage(
        chatId,
        loading.message_id,
        renderScanProgress(progress, progressTracker, { kind: "scan", venue })
      );
    });
















    for (const signal of allScanSignals(result)) {
      attachSignalLifecycle(signal);
      storeSignal(signal, "manual_scan");
    }
    recordScan("manual", "success");
    rememberLatestScan(chatId, { result, venue, mode: "scan" });
    await safeEditMessage(
      chatId,
      loading.message_id,
      formatScanSummary(result, { venue }),
      { reply_markup: scanSummaryKeyboard(venue) }
    );
















  } catch (error) {
    console.error("Manual market scan failed:", error);
    recordScan("manual", "error");
















    await safeEditMessage(
      chatId,
      loading.message_id,
      formatErrorState("PerpsIA scan unavailable", error)
    );
  } finally {
    unlockScan();
  }
}


async function runAlphaScan(chatId) {
  const venue = preferredVenue(chatId, "Binance");
  if (!lockScan()) {
    return bot.sendMessage(chatId, "PERPSIA SCAN IN PROGRESS\n\nAnother market scan is already running. Please wait for it to finish.");
  }

  const loading = await bot.sendMessage(chatId, formatProgress({ kind: "alpha", venue, percent: 5 }));
  const progressTracker = { seen: new Set(), total: null };
  try {
    const result = await runMarketScan(venue, async (progress) => {
      await safeEditMessage(chatId, loading.message_id, renderScanProgress(progress, progressTracker, { kind: "alpha", venue }));
    }, {
      isNewToken: true,
      cexAvailable: true,
    });

    for (const signal of allScanSignals(result)) {
      attachSignalLifecycle(signal);
      storeSignal(signal, "alpha_scan");
    }
    recordScan("alpha", "success");

    const alphaCandidates = allScanSignals(result)
      .filter((signal) => (signal.marketEvidence || []).some((record) =>
        ["dexscreener", "geckoterminal"].includes(String(record?.provider || "").toLowerCase()) && record.status === "ok"
      ))
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

    rememberLatestScan(chatId, { result, venue, mode: "alpha", alphaCandidates });
    if (!alphaCandidates.length) {
      return safeEditMessage(chatId, loading.message_id, "ALPHA SCAN COMPLETE\n\nNo early-momentum candidates had enough verified DEX data.", {
        reply_markup: { inline_keyboard: [[{ text: "🔄 Run Again", callback_data: "alpha_again", style: "primary" }]] },
      });
    }

    const selected = alphaCandidates.slice(0, 3);
    const rows = [];
    for (const signal of selected) rows.push(...signalReplyMarkup(signal, { venue, alpha: true }).inline_keyboard);
    rows.push([{ text: "🔄 Run Again", callback_data: "alpha_again", style: "primary" }]);
    return safeEditMessage(
      chatId,
      loading.message_id,
      ["ALPHA SCAN COMPLETE", "", ...selected.map((signal) => formatAlphaCard(signal))].join("\n\n"),
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (error) {
    console.error("Alpha scan failed:", error);
    recordScan("alpha", "error");
    return safeEditMessage(chatId, loading.message_id, formatErrorState("Early alpha unavailable", error));
  } finally {
    unlockScan();
  }
}
















// ==========================================
// MARKET SCAN COMMAND
// ==========================================
















bot.onText(/^\/scan(?:@\w+)?(?:\s+([A-Za-z]+))?$/i, async (msg, match) => {
  const venue = match[1] || preferredVenue(msg.chat.id);
















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
  venue = "Binance",
  options = {}
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
















  venue = normalizeVenue(venue);
















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
    formatProgress({
      kind: options.mode === "alpha" ? "alpha" : "analysis",
      symbol,
      venue,
      percent: 5,
    })
  );

  const progressTracker = { seen: new Set(), total: 1 };
















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
          renderScanProgress(progress, progressTracker, {
            kind: options.mode === "alpha" ? "alpha" : "analysis",
            symbol,
            venue,
          })
        );
      },
      options.scanOptions || {}
    );
















    recordTelemetrySignal(result);
    recordScan("manual_analysis", "success");
    // ======================================
    // LIFECYCLE ENGINE
    // ======================================
















    const lifecycle = getLifecycleStage(
      result,
      previous
    );
















    result.lifecycleStage = lifecycle.stage;
    recordPerformanceSignal(result, "manual_analysis");
















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
    recordAccountAnalysis(chatId, {
      symbol,
      venue,
      analysisType: options.mode === "alpha" ? "early_alpha" : "asset_analysis",
      requestSource: "telegram",
      signalReference: result.lifecycleStage || result.category || null,
      metadata: { actionable: Boolean(result.isActionable), score: result.score ?? null },
    });
















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
















    const divergenceText = formatDivergenceReport(result.divergences);
















    const liquidationText = formatLiquidationFlow(result.liquidationFlow);
    const whaleText = formatWhaleActivity(result.whaleActivity);
    const correlationText = formatCorrelationReport(result.correlation);
















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
















    const finalMessage = options.mode === "alpha"
      ? formatAlphaCard(result, { lifecycle })
      : formatSignalCard(result, {
          lifecycle,
          counter: counterThesis,
          memory: memoryChange,
          riskPlan,
        });
















    // ======================================
    // COMPLETE PROGRESS MESSAGE
    // ======================================
















    await safeEditMessage(
      chatId,
      loading.message_id,
      finalMessage,
      { reply_markup: signalReplyMarkup(result, { venue, alpha: options.mode === "alpha" }) }
    );
















  } catch (error) {
    console.error(
      `Analysis failed for ${symbol}:`,
      error
    );
    recordScan("manual_analysis", "error");
















    await safeEditMessage(
      chatId,
      loading.message_id,
      formatErrorState(symbol + " analysis unavailable", error)
    );
  } finally {
    isAnalyzeRunning = false;
  }
}
















// ==========================================
// /ANALYZE COMMAND ROUTER
// ==========================================
















bot.onText(
  /^\/analyze(?:@\w+)?(?:\s+\$?([A-Za-z0-9]+)(?:\s+([A-Za-z]+))?)?$/i,
  async (msg, match) => {
    const chatId = msg.chat.id;

    if (!match[1]) {
      return bot.sendMessage(chatId, "ANALYZE TOKEN\n\nUse /analyze BTC\n\nOptional venue: /analyze SOL Bybit");
    }
















    const symbol =
      match[1].toUpperCase();
















    const venue =
      match[2] || preferredVenue(chatId);
















    await runAssetAnalysis(
      chatId,
      symbol,
      venue
    );
  }
);


bot.onText(/^\/alpha(?:@\w+)?(?:\s+\$?([A-Za-z0-9]+))?$/i, async (msg, match) => {
  if (!match[1]) return runAlphaScan(msg.chat.id);
  return runAssetAnalysis(msg.chat.id, match[1], preferredVenue(msg.chat.id), {
    mode: "alpha",
    scanOptions: { isNewToken: true, cexAvailable: true },
  });
});


bot.onText(/^\/watchlist(?:@\w+)?(?:\s+(add|remove)\s+\$?([A-Za-z0-9]+))?$/i, async (msg, match) => {
  if (!match[1]) return showWatchlist(msg.chat.id);
  return changeWatchlist(msg.chat.id, match[1].toLowerCase(), match[2]);
});


bot.on("my_chat_member", (update) => {
  const chatId = update?.chat?.id;
  const status = update?.new_chat_member?.status;
  if (chatId && (status === "kicked" || status === "left")) markUserStatus(chatId, "blocked");
});

bot.onText(/^\/account(?:@\w+)?$/i, async (msg) => {
  try {
    const session = createTelegramLinkSession(msg.chat.id, {
      metadata: {
        username: msg.from?.username || null,
        firstName: msg.from?.first_name || null,
      },
    });
    return bot.sendMessage(msg.chat.id, [
      "PERPSIA ACCOUNT",
      "",
      "Open this secure link to continue on the PerpsIA dashboard:",
      session.url,
      "",
      "The link expires in 10 minutes and can only be used once.",
    ].join("\n"));
  } catch (error) {
    console.error("Account link creation failed:", error);
    return bot.sendMessage(msg.chat.id, "Account linking is temporarily unavailable. Please try again shortly.");
  }
});
bot.onText(/^\/mystats(?:@\w+)?$/i, async (msg) => {
  return bot.sendMessage(msg.chat.id, formatPrivateStats(msg.chat.id));
});

bot.onText(/^\/adminstats(?:@\w+)?$/i, async (msg) => {
  if (!requireAdmin(msg.chat.id)) return;
  const stats = getAdminStats();
  return bot.sendMessage(msg.chat.id, [
    "PRIVATE ADMIN ANALYTICS",
    "",
    "Total users: " + stats.users,
    "Active 24h: " + stats.active24h,
    "Active 7d: " + stats.active7d,
    "Blocked users: " + stats.blocked,
    "Events 24h: " + stats.events24h,
  ].join("\n"));
});

bot.onText(/^\/users(?:@\w+)?$/i, async (msg) => {
  if (!requireAdmin(msg.chat.id)) return;
  const users = getAdminUsers();
  return bot.sendMessage(msg.chat.id, [
    "PRIVATE USER DIRECTORY",
    "",
    ...users.map((user) => (user.username ? "@" + user.username : user.chat_id) + " · " + user.status + " · last seen " + user.last_seen_at),
  ].join("\n"));
});

bot.onText(/^\/leaderboard(?:@\w+)?$/i, async (msg) => {
  if (!requireAdmin(msg.chat.id)) return;
  const leaderboard = getLeaderboard();
  if (!leaderboard.length) return bot.sendMessage(msg.chat.id, "PRIVATE LEADERBOARD\n\nNo paper trades recorded yet.");
  return bot.sendMessage(msg.chat.id, [
    "PRIVATE PAPER LEADERBOARD",
    "",
    ...leaderboard.map((row, index) => {
      const name = row.user.username ? "@" + row.user.username : row.user.chat_id;
      return (index + 1) + ". " + name + " · " + (row.stats.realized >= 0 ? "+" : "") + "$" + row.stats.realized.toFixed(2) + " · " + row.stats.winRate.toFixed(1) + "% win rate";
    }),
  ].join("\n"));
});
bot.onText(/^\/paper(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
  const request = parsePaperCommand(match[1] || "help");
  return handlePaperRequest(msg.chat.id, request);
});

bot.onText(/^\/history(?:@\w+)?(?:\s+\$?([A-Za-z0-9]+))?$/i, async (msg, match) => {
  return runHistory(msg.chat.id, match[1]);
});


bot.onText(/^\/compare(?:@\w+)?(?:\s+\$?([A-Za-z0-9]+)\s+\$?([A-Za-z0-9]+))?$/i, async (msg, match) => {
  return runComparison(msg.chat.id, match[1], match[2], preferredVenue(msg.chat.id));
});


bot.onText(/^\/performance(?:@\w+)?$/i, async (msg) => {
  return runPerformanceReport(msg.chat.id);
});


bot.onText(/^\/settings(?:@\w+)?$/i, async (msg) => {
  return showSettings(msg.chat.id);
});


bot.onText(/^\/about(?:@\w+)?$/i, async (msg) => {
  return bot.sendMessage(msg.chat.id, ABOUT_MESSAGE);
});
















// ==========================================
// NATURAL LANGUAGE INTENT ROUTER
// ==========================================
















bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  trackUser(msg, text?.startsWith("/start") ? "start" : "message");
















  if (!text) return;
  if (text.startsWith("/")) return;

  const paperRequest = parsePaperCommand(text);
  if (paperRequest) return handlePaperRequest(chatId, paperRequest);
















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
      return runAssetAnalysis(chatId, symbol, preferredVenue(chatId));
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
        route.venue || preferredVenue(chatId)
      );
    }
















    if (route.intent === "scan_market") {
      return runManualScan(chatId, route.venue || preferredVenue(chatId));
    }

    if (route.intent === "alpha") {
      if (route.symbol) {
        return runAssetAnalysis(chatId, route.symbol, preferredVenue(chatId), {
          mode: "alpha",
          scanOptions: { isNewToken: true, cexAvailable: true },
        });
      }
      return runAlphaScan(chatId);
    }

    if (route.intent === "compare_assets") {
      return runComparison(chatId, route.symbols?.[0], route.symbols?.[1], preferredVenue(chatId));
    }

    if (route.intent === "watchlist_add") return changeWatchlist(chatId, "add", route.symbol);
    if (route.intent === "watchlist") return showWatchlist(chatId);
    if (route.intent === "history") return runHistory(chatId, route.symbol);
    if (route.intent === "performance") return runPerformanceReport(chatId);
    if (route.intent === "settings") return showSettings(chatId);
    if (route.intent === "about") return bot.sendMessage(chatId, ABOUT_MESSAGE);
















    if (route.intent === "set_risk") {
      const capital = Number(route.capital);
      const riskPercent = Number(route.riskPercent);
      const savedRisk = getRiskSettings(chatId);
      const maxLeverage = Number(route.maxLeverage ?? savedRisk?.max_leverage);
















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
          `I understood the risk request, but I need all 3 values.

Example:
I have $500, risk 1%, max leverage 5x`
        );
      }
















      saveRiskSettings(chatId, capital, riskPercent, maxLeverage);
















      return showRiskProfile(chatId);
    }
















    if (route.intent === "status") {
      return showUserStatus(chatId);
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
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const action = String(query.data || "");
















  await bot.answerCallbackQuery(query.id);
















  if (!chatId) return;

  try {
    if (action.startsWith("paper_refresh:")) {
      const positionId = Number(action.slice("paper_refresh:".length));
      const owned = getPaperOpenPositions(chatId).find((position) => position.id === positionId);
      if (!owned) return bot.sendMessage(chatId, "This paper position is no longer open.");
      const result = await refreshPaperPositions(chatId);
      const updated = result.updated.find((position) => position.id === positionId);
      const closed = result.closed.find((position) => position.id === positionId);
      if (closed) return sendPaperClosedCard(chatId, closed);
      return sendPaperCard(chatId, updated || owned, messageId);
    }

    if (action.startsWith("paper_close:")) {
      const positionId = Number(action.slice("paper_close:".length));
      const owned = getPaperOpenPositions(chatId).find((position) => position.id === positionId);
      if (!owned) return bot.sendMessage(chatId, "This paper position is already closed.");
      const result = await refreshPaperPositions(chatId);
      const current = result.updated.find((position) => position.id === positionId) || owned;
      const closed = closePaperPosition(current.id, current.mark_price, "MANUAL");
      return sendPaperClosedCard(chatId, closed);
    }
    if (action === "scan_market") {
      return runManualScan(chatId, preferredVenue(chatId));
    }

    if (action === "early_alpha" || action === "alpha_again") {
      return runAlphaScan(chatId);
    }

    if (action === "show_watchlist") {
      return showWatchlist(chatId, messageId);
    }

    if (action === "show_settings") {
      return showSettings(chatId, messageId);
    }

    if (action === "scan_view:top") {
      return showScanBucket(chatId, messageId, "top");
    }

    if (action === "scan_view:watchlist") {
      return showScanBucket(chatId, messageId, "watchlist");
    }

    if (action === "scan_view:summary") {
      const latest = latestScansByChat.get(String(chatId));
      if (!latest) return bot.sendMessage(chatId, "No recent scan is available. Use /scan first.");
      return safeEditMessage(
        chatId,
        messageId,
        formatScanSummary(latest.result, { venue: latest.venue }),
        { reply_markup: scanSummaryKeyboard(latest.venue) }
      );
    }

    if (action.startsWith("scan_again:")) {
      return runManualScan(chatId, action.slice("scan_again:".length) || preferredVenue(chatId));
    }

    if (action.startsWith("analyze:")) {
      const [, symbol, venue] = action.split(":");
      if (symbol) return runAssetAnalysis(chatId, symbol, venue || preferredVenue(chatId));
    }

    if (action.startsWith("track:")) {
      const symbol = action.slice("track:".length);
      return changeWatchlist(chatId, "add", symbol);
    }

    if (action.startsWith("watch_remove:")) {
      return changeWatchlist(chatId, "remove", action.slice("watch_remove:".length), messageId);
    }

    if (action.startsWith("settings_venue:")) {
      const venue = normalizeVenue(action.slice("settings_venue:".length));
      saveUserPreferences(chatId, { preferred_exchange: venue });
      return showSettings(chatId, messageId);
    }

    if (action.startsWith("settings_frequency:")) {
      const frequency = action.slice("settings_frequency:".length);
      if (!["1h", "4h", "12h"].includes(frequency)) throw new Error("Unsupported alert frequency");
      saveUserPreferences(chatId, { alert_frequency: frequency });
      return showSettings(chatId, messageId);
    }

    if (action.startsWith("settings_sensitivity:")) {
      const sensitivity = action.slice("settings_sensitivity:".length);
      if (!["conservative", "balanced", "aggressive"].includes(sensitivity)) throw new Error("Unsupported signal sensitivity");
      saveUserPreferences(chatId, { signal_sensitivity: sensitivity });
      return showSettings(chatId, messageId);
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
      await showRiskProfile(chatId);
      return bot.sendMessage(
        chatId,
        `Update your risk profile like this:

/risk 500 1 5

Or say naturally:

I have $500, risk 1%, max leverage 5x`
      );
    }
















    if (action === "show_commands") {
      return bot.sendMessage(chatId, getHelpMessage());
    }
  } catch (error) {
    console.error("Telegram callback failed:", error);
    return bot.sendMessage(chatId, formatErrorState("Action unavailable", error));
  }
});
















// ==========================================
// CHAT ID COMMAND
// ==========================================
















bot.onText(/^\/chatid(?:@\w+)?$/i, async (msg) => {
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
















bot.onText(/^\/status(?:@\w+)?$/i, async (msg) => {
















  return showUserStatus(msg.chat.id);
});
















const stopPaperTradingMonitor = startPaperTradingMonitor(async (position) => {
  await sendPaperClosedCard(String(position.chat_id), position);
});

void startTelegramPolling();
















// ==========================================
// START AUTONOMOUS SCHEDULER
// ==========================================
















const streamManager = getStreamManager();
streamManager.start();
startAlchemyWatchlistSync();
startWalletRefresh();

startScheduler({
  bot,
  chatId: autonomousChatId,
});
















// ==========================================
// RENDER HEALTH SERVER
// ==========================================
















const http = require("http");








const PORT = process.env.PORT || 3000;








const healthServer = http
  .createServer((req, res) => {
    void handleHttpRequest(req, res);
  })
  .listen(PORT, () => {
    console.log("Perpsia health and metrics server listening on port " + PORT);
  });

function shutdown(signal) {
  structuredLog("info", "shutdown_started", { signal });
  streamManager.stop();
  stopScheduler();
  clearTelegramPollingRetry();
  releaseTelegramPollingLock();
  stopAlchemyWatchlistSync();
  stopWalletRefresh();
  stopPaperTradingMonitor?.();
  try { bot.stopPolling?.(); } catch (error) {
    structuredLog("warn", "telegram_polling_stop_failed", { message: error.message });
  }
  healthServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref?.();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
// ==========================================
// STARTUP
// ==========================================
















console.log("✅ Perpsia Terminal v2.1 is running...");
console.log("📡 TIER 1 CRITICAL GAPS RESOLVED:");
console.log("   ✅ Live CMC Skill Hub connection");
console.log("   ✅ Request queue with retry logic");
console.log("   ✅ Multi-exchange support (Binance, Bybit, OKX, Dydx, Hyperliquid)");
console.log("   ✅ Backtester framework (ready for integration)");
console.log("   ✅ Public paper-performance leaderboard at /performance");
console.log("   ✅ Prometheus metrics at /metrics");
console.log("   ✅ CMC retries and circuit breaker");
