"use strict";

const { refreshGmgnSmartMoney } = require("./providers/gmgn");
const { recalculateWalletQuality } = require("./walletRegistry");
const { increment, structuredLog } = require("./telemetry");

let timer = null;
let lastRefresh = null;
let lastError = null;

function configuredChains(options = {}) {
  const raw = options.chains || options.chain || process.env.PERPSIA_GMGN_REFRESH_CHAINS || "sol,ethereum";
  return String(raw).split(",").map((item) => item.trim()).filter(Boolean);
}

async function refreshWalletWatchlist(options = {}) {
  const result = { status: "skipped", chains: [], quality: [], errors: [], startedAt: Date.now() };
  if (process.env.PERPSIA_WALLET_REFRESH_ENABLED !== "true" && options.enabled !== true) {
    result.reason = "PERPSIA_WALLET_REFRESH_ENABLED is not true";
    lastRefresh = result;
    return result;
  }
  try {
    for (const chain of configuredChains(options)) {
      const refreshed = await refreshGmgnSmartMoney({ ...options, chain, limit: options.limit || process.env.GMGN_SMART_MONEY_LIMIT });
      result.chains.push(refreshed);
      increment("wallet_imports_total", { source: "gmgn", status: refreshed.status });
    }
    result.quality = recalculateWalletQuality();
    result.status = "refreshed";
    result.completedAt = Date.now();
    lastError = null;
    structuredLog("info", "wallet_watchlist_refreshed", { chains: result.chains.length, quality: result.quality.length });
  } catch (error) {
    result.status = "error";
    result.errors.push(error.message);
    result.completedAt = Date.now();
    lastError = error.message;
    increment("wallet_imports_total", { source: "refresh", status: "error" });
  }
  lastRefresh = result;
  return result;
}

function startWalletRefresh(options = {}) {
  if (timer) return { started: false, reason: "already_running" };
  const intervalMs = Math.max(3600000, Number(options.intervalMs || process.env.PERPSIA_GMGN_REFRESH_INTERVAL_MS || 21600000));
  if (process.env.PERPSIA_WALLET_REFRESH_ENABLED === "true" || options.enabled === true) {
    void refreshWalletWatchlist(options).catch(() => {});
  }
  timer = setInterval(() => { void refreshWalletWatchlist(options).catch(() => {}); }, intervalMs);
  timer.unref?.();
  return { started: true, intervalMs, enabled: process.env.PERPSIA_WALLET_REFRESH_ENABLED === "true" || options.enabled === true };
}

function stopWalletRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
}

function getWalletRefreshHealth() {
  return { status: lastRefresh?.status || "not_run", lastError, lastRefresh, running: Boolean(timer) };
}

module.exports = {
  getWalletRefreshHealth,
  refreshWalletWatchlist,
  startWalletRefresh,
  stopWalletRefresh,
};
