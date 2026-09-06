"use strict";

const { getStreamDefinition, openPublicStream } = require("./streams");
const { upsertSnapshot } = require("./liveSnapshotStore");
const { increment, setGauge, structuredLog } = require("../telemetry");

function normalizedSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase().replace(/^\$/, "").replace(/(USDT|USDC|USD)$/, "");
}

function streamKey(provider, symbol) {
  return String(provider || "").toLowerCase() + ":" + normalizedSymbol(symbol);
}

class StreamManager {
  constructor(options = {}) {
    this.openStream = options.openStream || openPublicStream;
    this.now = options.now || (() => Date.now());
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.staleAfterMs = Number(options.staleAfterMs || process.env.PERPSIA_WS_STALE_MS || 30_000);
    this.idleTtlMs = Number(options.idleTtlMs || process.env.PERPSIA_WS_IDLE_TTL_MS || 15 * 60_000);
    this.maxBackoffMs = Number(options.maxBackoffMs || 60_000);
    this.entries = new Map();
    this.pruneTimer = null;
  }

  start() {
    if (!this.pruneTimer) {
      this.pruneTimer = this.setTimeout(() => this.pruneIdle(), Math.min(this.idleTtlMs, 60_000));
      this.pruneTimer?.unref?.();
    }
    return this;
  }

  subscribe(provider, symbol) {
    const key = streamKey(provider, symbol);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastRequestedAt = this.now();
      return existing;
    }
    if (!getStreamDefinition(provider)) return null;
    if (this.openStream === openPublicStream && typeof WebSocket !== "function") return null;
    const entry = {
      key,
      provider: String(provider).toLowerCase(),
      symbol: normalizedSymbol(symbol),
      status: "connecting",
      createdAt: this.now(),
      lastRequestedAt: this.now(),
      lastMessageAt: null,
      lastConnectedAt: null,
      lastError: null,
      reconnectCount: 0,
      subscriptions: 1,
      socketHandle: null,
      reconnectTimer: null,
      watchdogTimer: null,
      closed: false,
    };
    this.entries.set(key, entry);
    this.start().connect(entry);
    return entry;
  }

  ensureSubscriptions(providers, symbol) {
    const result = [];
    for (const provider of providers || []) {
      const entry = this.subscribe(provider, symbol);
      if (entry) result.push(entry);
    }
    return result;
  }

  connect(entry) {
    if (!entry || entry.closed) return;
    entry.status = "connecting";
    try {
      entry.socketHandle = this.openStream(
        entry.provider,
        entry.symbol,
        (evidence) => this.onEvidence(entry, evidence),
        {
          onOpen: () => this.onOpen(entry),
          onError: (error) => this.onError(entry, error),
          onClose: () => this.onClose(entry),
        },
      );
      if (!entry.socketHandle) throw new Error("Stream factory returned no socket handle");
      this.scheduleWatchdog(entry);
    } catch (error) {
      this.onError(entry, error);
      this.scheduleReconnect(entry);
    }
  }

  onOpen(entry) {
    if (entry.closed) return;
    entry.status = "connected";
    entry.lastConnectedAt = this.now();
    entry.lastError = null;
    this.scheduleWatchdog(entry);
    this.updateActiveGauge();
  }

  onEvidence(entry, evidence) {
    if (entry.closed) return;
    entry.status = "connected";
    entry.lastMessageAt = this.now();
    entry.lastError = null;
    upsertSnapshot(evidence, this.now());
    increment("perpsia_websocket_messages_total", { provider: entry.provider });
    this.scheduleWatchdog(entry);
    this.updateActiveGauge();
  }

  onError(entry, error) {
    if (!entry || entry.closed) return;
    entry.status = "degraded";
    entry.lastError = String(error?.message || error || "WebSocket error");
    this.updateActiveGauge();
  }

  onClose(entry) {
    if (!entry || entry.closed) return;
    entry.status = "disconnected";
    this.updateActiveGauge();
    this.scheduleReconnect(entry);
  }

  scheduleWatchdog(entry) {
    if (entry.watchdogTimer) this.clearTimeout(entry.watchdogTimer);
    entry.watchdogTimer = this.setTimeout(() => {
      if (entry.closed) return;
      const lastActivity = entry.lastMessageAt || entry.lastConnectedAt || entry.createdAt;
      if (this.now() - lastActivity > this.staleAfterMs) {
        entry.status = "stale";
        increment("perpsia_websocket_stale_streams", { provider: entry.provider });
        try { entry.socketHandle?.close?.(); } catch {}
        this.scheduleReconnect(entry);
      } else {
        this.scheduleWatchdog(entry);
      }
    }, Math.max(1000, Math.min(this.staleAfterMs, 10_000)));
    entry.watchdogTimer?.unref?.();
  }

  scheduleReconnect(entry) {
    if (entry.closed || entry.reconnectTimer) return;
    entry.reconnectCount += 1;
    increment("perpsia_websocket_reconnects_total", { provider: entry.provider });
    const delay = Math.min(this.maxBackoffMs, 1000 * (2 ** Math.min(entry.reconnectCount - 1, 6)));
    entry.reconnectTimer = this.setTimeout(() => {
      entry.reconnectTimer = null;
      if (!entry.closed) this.connect(entry);
    }, delay);
    entry.reconnectTimer?.unref?.();
    structuredLog("warn", "websocket_reconnect_scheduled", {
      provider: entry.provider,
      symbol: entry.symbol,
      delayMs: delay,
      reconnectCount: entry.reconnectCount,
    });
  }

  unsubscribe(provider, symbol) {
    const key = streamKey(provider, symbol);
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.closed = true;
    if (entry.reconnectTimer) this.clearTimeout(entry.reconnectTimer);
    if (entry.watchdogTimer) this.clearTimeout(entry.watchdogTimer);
    try { entry.socketHandle?.close?.(); } catch {}
    this.entries.delete(key);
    this.updateActiveGauge();
    return true;
  }

  pruneIdle() {
    const cutoff = this.now() - this.idleTtlMs;
    for (const entry of this.entries.values()) {
      if (entry.lastRequestedAt < cutoff) this.unsubscribe(entry.provider, entry.symbol);
    }
    if (this.entries.size) {
      this.pruneTimer = this.setTimeout(() => this.pruneIdle(), Math.min(this.idleTtlMs, 60_000));
      this.pruneTimer?.unref?.();
    }
    else this.pruneTimer = null;
  }

  stop() {
    for (const entry of [...this.entries.values()]) this.unsubscribe(entry.provider, entry.symbol);
    if (this.pruneTimer) this.clearTimeout(this.pruneTimer);
    this.pruneTimer = null;
    this.updateActiveGauge();
  }

  updateActiveGauge() {
    setGauge("perpsia_websocket_connections_active", [...this.entries.values()].filter((item) => item.status === "connected").length);
  }

  getHealth() {
    return [...this.entries.values()].map((entry) => ({
      provider: entry.provider,
      symbol: entry.symbol,
      status: entry.status,
      lastConnectedAt: entry.lastConnectedAt ? new Date(entry.lastConnectedAt).toISOString() : null,
      lastMessageAt: entry.lastMessageAt ? new Date(entry.lastMessageAt).toISOString() : null,
      reconnectCount: entry.reconnectCount,
      currentSubscriptions: entry.subscriptions,
      staleStream: entry.status === "stale",
      lastError: entry.lastError,
    }));
  }

  getProviderHealth() {
    const grouped = new Map();
    for (const item of this.getHealth()) {
      if (!grouped.has(item.provider)) grouped.set(item.provider, []);
      grouped.get(item.provider).push(item);
    }
    return [...grouped.entries()].map(([provider, streams]) => ({
      provider,
      status: streams.some((item) => item.status === "connected") ? "connected" : streams[0]?.status || "idle",
      reconnectCount: streams.reduce((sum, item) => sum + item.reconnectCount, 0),
      currentSubscriptions: streams.reduce((sum, item) => sum + item.currentSubscriptions, 0),
      staleStream: streams.some((item) => item.staleStream),
      lastMessageAt: streams.map((item) => item.lastMessageAt).filter(Boolean).sort().at(-1) || null,
      streams,
    }));
  }
}

let singleton = null;

function getStreamManager(options = {}) {
  if (!singleton) singleton = new StreamManager(options);
  return singleton;
}

function resetStreamManagerForTests() {
  singleton?.stop();
  singleton = null;
}

module.exports = {
  StreamManager,
  getStreamManager,
  resetStreamManagerForTests,
  normalizedSymbol,
  streamKey,
};
