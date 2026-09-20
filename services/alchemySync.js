"use strict";

const axios = require("axios");
const { CircuitBreaker, executeWithResilience } = require("./resilience");
const { increment, observe, setGauge, structuredLog } = require("./telemetry");
const {
  listWallets,
  normalizeChain,
  listAlchemyWebhooks,
  upsertAlchemySync,
  upsertAlchemyWebhook,
} = require("./walletRegistry");

const ALCHEMY_NOTIFY_BASE = "https://dashboard.alchemy.com/api";
const NETWORKS = {
  ethereum: "ETH_MAINNET",
  base: "BASE_MAINNET",
  arbitrum: "ARB_MAINNET",
  optimism: "OPT_MAINNET",
  polygon: "MATIC_MAINNET",
  bsc: "BNB_MAINNET",
};
const syncCircuitBreaker = new CircuitBreaker(4, 120000, { name: "Alchemy Notify webhook management" });
let lastSync = null;
let lastError = null;
let periodicTimer = null;

function timeoutMs(options = {}) {
  return Math.max(1000, Number(options.timeoutMs || process.env.ALCHEMY_TIMEOUT_MS || 8000));
}

function authToken(options = {}) {
  return String(options.authToken || process.env.ALCHEMY_NOTIFY_AUTH_TOKEN || "").trim();
}

function webhookUrl(options = {}) {
  const configured = String(options.webhookUrl || process.env.ALCHEMY_WEBHOOK_URL || "").trim();
  if (configured) {
    const normalized = configured.replace(/\/+$/, "");
    return normalized.endsWith("/webhooks/alchemy") ? normalized : normalized + "/webhooks/alchemy";
  }
  const renderUrl = String(process.env.RENDER_EXTERNAL_URL || "").trim();
  return renderUrl ? renderUrl.replace(/\/$/, "") + "/webhooks/alchemy" : "";
}

function configuredNetworks() {
  const raw = String(process.env.ALCHEMY_NETWORKS || "ethereum,base,arbitrum,optimism,polygon,bnb");
  return raw.split(",").map((item) => normalizeChain(item)).filter((item) => NETWORKS[item]);
}

function flattenData(payload) {
  if (Array.isArray(payload)) return payload.flatMap(flattenData);
  if (Array.isArray(payload?.data)) return payload.data.flatMap(flattenData);
  if (payload?.data && typeof payload.data === "object") return flattenData(payload.data);
  return payload && typeof payload === "object" ? [payload] : [];
}

function redactDiagnosticValue(value, depth = 0) {
  if (depth > 4) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(/(authorization|x-alchemy-token|token|secret|signing[_-]?key|api[_-]?key)\s*[:=]\s*["']?[^,\s}"']+/gi, "$1=[REDACTED]")
      .slice(0, 2000);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactDiagnosticValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
      key,
      /authorization|token|secret|signing[_-]?key|api[_-]?key/i.test(key)
        ? "[REDACTED]"
        : redactDiagnosticValue(item, depth + 1),
    ]));
  }
  return value;
}

function requestMetadata(method, endpoint, params, data) {
  const metadata = {
    method,
    endpoint,
    baseUrl: ALCHEMY_NOTIFY_BASE,
    queryKeys: Object.keys(params || {}),
    bodyKeys: Object.keys(data || {}),
  };
  if (params?.webhook_id) metadata.webhookId = String(params.webhook_id).slice(0, 120);
  if (data?.network) metadata.network = data.network;
  if (data?.webhook_type) metadata.webhookType = data.webhook_type;
  if (Array.isArray(data?.addresses)) {
    metadata.addressCount = data.addresses.length;
    metadata.uniqueAddressCount = new Set(data.addresses.map((address) => String(address).toLowerCase())).size;
  }
  if (Array.isArray(data?.addresses_to_add)) metadata.addressesToAddCount = data.addresses_to_add.length;
  if (Array.isArray(data?.addresses_to_remove)) metadata.addressesToRemoveCount = data.addresses_to_remove.length;
  return metadata;
}

async function notifyRequest(method, path, options = {}, params, data) {
  const token = authToken(options);
  if (!token) throw new Error("ALCHEMY_NOTIFY_AUTH_TOKEN is not configured");
  const startedAt = Date.now();
  const metadata = requestMetadata(method, path, params, data);
  try {
    const response = await executeWithResilience(() => axios.request({
      method,
      url: ALCHEMY_NOTIFY_BASE + path,
      params,
      data,
      timeout: timeoutMs(options),
      headers: {
        "X-Alchemy-Token": token,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "perpsia-alchemy-watchlist/1.0",
      },
      validateStatus: () => true,
    }), { breaker: syncCircuitBreaker, retries: 2, baseDelayMs: 300, maxDelayMs: 2000 });
    if (response.status >= 400) {
      const error = new Error("Alchemy Notify returned HTTP " + response.status);
      error.status = response.status;
      error.endpoint = path;
      error.responseBody = redactDiagnosticValue(response.data);
      error.requestMetadata = metadata;
      structuredLog("error", "alchemy_notify_request_failed", {
        ...metadata,
        statusCode: response.status,
        responseBody: error.responseBody,
      });
      error.alchemyDiagnosticLogged = true;
      throw error;
    }
    observe("perpsia_onchain_latency_ms", Date.now() - startedAt, { provider: "alchemy_notify" });
    increment("alchemy_watchlist_sync_total", { operation: path, status: "success" });
    return response.data;
  } catch (error) {
    observe("perpsia_onchain_latency_ms", Date.now() - startedAt, { provider: "alchemy_notify" });
    increment("alchemy_watchlist_sync_errors_total", { operation: path });
    if (!error.alchemyDiagnosticLogged) {
      structuredLog("error", "alchemy_notify_transport_failed", {
        ...metadata,
        statusCode: error.status || error.response?.status || null,
        message: String(error.message || "Alchemy Notify request failed").slice(0, 500),
      });
    }
    throw error;
  }
}

function normalizeWebhook(item) {
  return {
    id: item.id || item.webhook_id,
    network: item.network,
    type: String(item.webhook_type || item.type || "").toUpperCase(),
    url: item.webhook_url || item.url || null,
    active: item.is_active !== false,
  };
}

async function listRemoteWebhooks(options = {}) {
  const payload = await notifyRequest("GET", "/team-webhooks", options);
  return flattenData(payload).map(normalizeWebhook).filter((item) => item.id);
}

async function getRemoteAddresses(webhookId, options = {}) {
  // Alchemy's Notify endpoint paginates this resource; 100 is the documented
  // page size and avoids a 400 from the management API for oversized limits.
  const payload = await notifyRequest("GET", "/webhook-addresses", options, { webhook_id: webhookId, limit: 100 });
  return flattenData(payload).map((item) => typeof item === "string" ? item : item.address).filter(Boolean).map((item) => String(item).toLowerCase());
}

async function createAddressWebhook(network, addresses, options = {}) {
  const payload = await notifyRequest("POST", "/create-webhook", options, null, {
    network,
    webhook_type: "ADDRESS_ACTIVITY",
    webhook_url: webhookUrl(options),
    name: "PerpsIA Address Activity — " + network,
    addresses,
  });
  const item = flattenData(payload)[0] || {};
  return normalizeWebhook({ ...item, network, webhook_type: "ADDRESS_ACTIVITY", webhook_url: webhookUrl(options) });
}

async function updateWebhookAddresses(webhookId, addressesToAdd, addressesToRemove, options = {}) {
  if (!addressesToAdd.length && !addressesToRemove.length) return false;
  await notifyRequest("PATCH", "/update-webhook-addresses", options, null, {
    webhook_id: webhookId,
    addresses_to_add: addressesToAdd,
    addresses_to_remove: addressesToRemove,
  });
  return true;
}

function targetWallets(options = {}) {
  const minPriority = Math.max(0, Number(options.minSyncPriority ?? (process.env.PERPSIA_WALLET_MIN_SYNC_PRIORITY || 0)));
  const maxAddresses = Math.max(0, Number(options.maxAddresses ?? (process.env.PERPSIA_MAX_ALCHEMY_WATCHED_ADDRESSES || 0)));
  const eligible = listWallets({ enabled: true, alchemyEligible: true })
    .filter((wallet) => NETWORKS[normalizeChain(wallet.chain)] && /^0x[a-f0-9]{40}$/i.test(wallet.address))
    .filter((wallet) => Number(wallet.monitoringPriority || 0) >= minPriority)
    .sort((left, right) => Number(right.monitoringPriority || 0) - Number(left.monitoringPriority || 0) || Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  return {
    eligible,
    selected: maxAddresses > 0 ? eligible.slice(0, maxAddresses) : eligible,
    minPriority,
    maxAddresses: maxAddresses || null,
  };
}

async function syncAlchemyWatchlist(options = {}) {
  const result = {
    status: "skipped",
    reason: null,
    networks: {},
    syncedWalletCount: 0,
    unsyncedWalletCount: 0,
    errors: [],
    lastSyncAt: Date.now(),
  };
  if (process.env.ALCHEMY_ENABLED !== "true" && options.enabled !== true) {
    result.reason = "ALCHEMY_ENABLED is not true";
    lastSync = result;
    return result;
  }
  if (!authToken(options)) {
    result.reason = "ALCHEMY_NOTIFY_AUTH_TOKEN is not configured; manual webhook sync remains required.";
    lastSync = result;
    return result;
  }
  const url = webhookUrl(options);
  if (!url) {
    result.reason = "ALCHEMY_WEBHOOK_URL or RENDER_EXTERNAL_URL is not configured; manual webhook URL is required.";
    lastSync = result;
    return result;
  }
  const selection = targetWallets(options);
  const wallets = selection.selected;
  const managed = listAlchemyWebhooks();
  if (!wallets.length && !managed.length) {
    result.reason = "no eligible wallets or managed webhooks to synchronize";
    result.deferredWalletCount = 0;
    result.unsyncedWalletCount = 0;
    result.selection = {
      eligibleWalletCount: selection.eligible.length,
      selectedWalletCount: selection.selected.length,
      minPriority: selection.minPriority,
      maxAddresses: selection.maxAddresses,
    };
    lastError = null;
    lastSync = result;
    setGauge("alchemy_watched_addresses", 0);
    return result;
  }
  const byNetwork = new Map();
  for (const wallet of wallets) {
    const network = NETWORKS[normalizeChain(wallet.chain)];
    if (!byNetwork.has(network)) byNetwork.set(network, []);
    byNetwork.get(network).push(wallet);
  }
  const networks = [...new Set([...configuredNetworks().map((chain) => NETWORKS[chain]), ...byNetwork.keys()])];
  try {
    // Do not call Alchemy or inspect unrelated webhooks when there is no
    // selected wallet and no PerpsIA-managed webhook to reconcile.
    const remoteWebhooks = wallets.length || managed.length ? await listRemoteWebhooks(options) : [];
    for (const network of networks) {
      const chain = Object.entries(NETWORKS).find(([, value]) => value === network)?.[0] || normalizeChain(network);
      const desiredWallets = byNetwork.get(network) || [];
      const desired = new Set(desiredWallets.map((wallet) => wallet.address.toLowerCase()));
      const stored = managed.find((item) => item.network === chain);
      const expectedUrl = url.toLowerCase().replace(/\/+$/, "");
      const remote = remoteWebhooks.find((item) => item.id === stored?.webhook_id) || remoteWebhooks.find((item) =>
        String(item.network || "").toUpperCase() === String(network).toUpperCase() &&
        String(item.type || "").toUpperCase() === "ADDRESS_ACTIVITY" &&
        String(item.url || "").toLowerCase().replace(/\/+$/, "") === expectedUrl
      );
      if (!desiredWallets.length && !remote) {
        if (stored) {
          structuredLog("warn", "alchemy_managed_webhook_missing", { network: chain, webhookId: stored.webhook_id });
          result.networks[chain] = { status: "missing_remote_webhook", desiredAddresses: 0, added: 0, removed: 0 };
        }
        continue;
      }
      let webhook = remote;
      let managedByPerpsia = Boolean(stored?.managed_by_perpsia || remote?.url === url);
      if (!webhook) {
        webhook = await createAddressWebhook(network, [...desired], options);
        managedByPerpsia = true;
      }
      if (!webhook?.id) throw new Error("Alchemy did not return a webhook id for " + network);
      const existing = new Set(await getRemoteAddresses(webhook.id, options));
      const addressesToAdd = [...desired].filter((address) => !existing.has(address));
      const addressesToRemove = managedByPerpsia ? [...existing].filter((address) => !desired.has(address)) : [];
      await updateWebhookAddresses(webhook.id, addressesToAdd, addressesToRemove, options);
      upsertAlchemyWebhook(chain, { webhookId: webhook.id, webhookUrl: url, managedByPerpsia, syncStatus: "synced" });
      for (const wallet of desiredWallets) {
        upsertAlchemySync(wallet.id, wallet.chain, { alchemySubscribed: true, alchemyWebhookId: webhook.id, alchemySyncStatus: "synced" });
      }
      result.networks[chain] = { webhookId: webhook.id, desiredAddresses: desired.size, added: addressesToAdd.length, removed: addressesToRemove.length, status: "synced" };
      result.syncedWalletCount += desiredWallets.length;
    }
    result.status = "synced";
    lastError = null;
  } catch (error) {
    result.status = "error";
    result.errors.push(error.message);
    lastError = error.message;
    increment("alchemy_watchlist_sync_errors_total", { operation: "sync" });
  }
  result.deferredWalletCount = Math.max(0, selection.eligible.length - selection.selected.length);
  result.unsyncedWalletCount = Math.max(0, selection.eligible.length - result.syncedWalletCount);
  result.selection = {
    eligibleWalletCount: selection.eligible.length,
    selectedWalletCount: selection.selected.length,
    minPriority: selection.minPriority,
    maxAddresses: selection.maxAddresses,
  };
  setGauge("alchemy_watched_addresses", result.syncedWalletCount);
  lastSync = result;
  return result;
}

function startAlchemyWatchlistSync(options = {}) {
  if (periodicTimer) return { started: false, reason: "already_running" };
  const intervalMs = Math.max(60000, Number(options.intervalMs || process.env.ALCHEMY_SYNC_INTERVAL_MS || 900000));
  void syncAlchemyWatchlist(options).catch(() => {});
  periodicTimer = setInterval(() => { void syncAlchemyWatchlist(options).catch(() => {}); }, intervalMs);
  periodicTimer.unref?.();
  return { started: true, intervalMs };
}

function stopAlchemyWatchlistSync() {
  if (periodicTimer) clearInterval(periodicTimer);
  periodicTimer = null;
}

function getAlchemySyncHealth() {
  return {
    status: lastSync?.status || "not_run",
    lastSyncAt: lastSync?.lastSyncAt || null,
    lastError,
    sync: lastSync,
    circuit: syncCircuitBreaker.snapshot(),
    manualConfigurationRequired: !authToken() || !webhookUrl(),
  };
}

module.exports = {
  NETWORKS,
  getAlchemySyncHealth,
  listRemoteWebhooks,
  startAlchemyWatchlistSync,
  stopAlchemyWatchlistSync,
  syncAlchemyWatchlist,
  targetWallets,
};
