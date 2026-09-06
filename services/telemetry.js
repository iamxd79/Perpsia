// ==========================================
// PERPSIA TELEMETRY: PROMETHEUS TEXT EXPORT
// ==========================================
// Dependency-free standard Prometheus output for Render and Grafana.

const counterDefinitions = {
  perpsia_signals_total: {
    help: "Total signals generated",
    labels: ["category", "symbol"],
  },
  perpsia_cmc_requests_total: {
    help: "CMC Skill Hub requests",
    labels: ["skill", "status"],
  },
  perpsia_cmc_errors_total: {
    help: "CMC Skill Hub errors",
    labels: ["skill", "kind"],
  },
  perpsia_scans_total: {
    help: "Market scans completed",
    labels: ["source", "status"],
  },
  perpsia_websocket_reconnects_total: {
    help: "WebSocket reconnects",
    labels: ["provider"],
  },
  perpsia_websocket_messages_total: {
    help: "WebSocket messages normalized",
    labels: ["provider"],
  },
  perpsia_websocket_stale_streams: {
    help: "WebSocket streams that became stale",
    labels: ["provider"],
  },
  perpsia_rest_fallback_total: {
    help: "REST fallbacks used because a live snapshot was unavailable or stale",
    labels: ["provider", "reason"],
  },
  perpsia_provider_conflicts_total: {
    help: "Material conflicts between WebSocket and REST evidence",
    labels: ["provider", "field"],
  },
  perpsia_onchain_requests_total: {
    help: "On-chain provider requests",
    labels: ["provider", "method", "status"],
  },
  perpsia_onchain_events_total: {
    help: "Normalized on-chain events",
    labels: ["provider", "status"],
  },
  perpsia_onchain_webhook_events_total: {
    help: "On-chain webhook events accepted",
    labels: ["provider", "status"],
  },
  perpsia_onchain_webhook_duplicates_total: {
    help: "Duplicate on-chain webhook events ignored",
    labels: ["provider"],
  },
  wallet_registry_total: {
    help: "Wallet registry operations",
    labels: ["operation", "status"],
  },
  wallet_events_total: {
    help: "Canonical wallet-linked on-chain events",
    labels: ["status"],
  },
  wallet_convergence_events_total: {
    help: "Wallet convergence observations",
    labels: ["symbol"],
  },
  smart_money_events_total: {
    help: "Smart Money observations",
    labels: ["symbol"],
  },
  exchange_flow_events_total: {
    help: "Exchange flow observations",
    labels: ["symbol"],
  },
  listing_watch_events_total: {
    help: "Listing watch observations",
    labels: ["level", "type"],
  },
  gmgn_wallet_imports_total: {
    help: "GMGN wallet imports",
    labels: ["status"],
  },
  alchemy_watchlist_sync_total: {
    help: "Alchemy watchlist synchronization operations",
    labels: ["operation", "status"],
  },
  alchemy_watchlist_sync_errors_total: {
    help: "Alchemy watchlist synchronization errors",
    labels: ["operation"],
  },
  wallet_watchlist_total: {
    help: "Wallet watchlist observations",
    labels: ["category", "chain"],
  },
  wallet_quality_tier_total: {
    help: "Wallets by deterministic quality tier",
    labels: ["tier"],
  },
  wallet_imports_total: {
    help: "Wallet watchlist imports and refreshes",
    labels: ["source", "status"],
  },
  wallet_import_rejections_total: {
    help: "Rejected wallet watchlist records",
    labels: ["source", "reason"],
  },
  wallet_priority_total: {
    help: "Wallets by monitoring priority",
    labels: ["priority"],
  },
  smart_money_high_quality_total: {
    help: "High-quality Smart Money wallets",
    labels: ["tier"],
  },
  exchange_wallets_verified_total: {
    help: "Verified exchange wallets",
    labels: ["exchange", "role"],
  },
};

const histogramDefinitions = {
  perpsia_signal_score: {
    help: "Signal score distribution",
    labels: [],
    buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
  },
  perpsia_cmc_latency_ms: {
    help: "CMC API latency in milliseconds",
    labels: [],
    buckets: [100, 500, 1000, 5000, 10000],
  },
  perpsia_live_snapshot_age_ms: {
    help: "Age of normalized live snapshots",
    labels: [],
    buckets: [100, 1000, 5000, 15000, 60000, 300000, 3600000],
  },
  perpsia_onchain_latency_ms: {
    help: "On-chain provider latency in milliseconds",
    labels: ["provider"],
    buckets: [100, 500, 1000, 5000, 10000, 30000],
  },
};

const counters = new Map();
const histograms = new Map();
const gauges = new Map([
  ["perpsia_up", 1],
  ["perpsia_open_signals", 0],
  ["perpsia_websocket_connections_active", 0],
  ["perpsia_live_snapshots_usable", 0],
  ["alchemy_watched_addresses", 0],
]);

function labelsKey(labels) {
  return JSON.stringify(labels || {});
}

function getCounterSeries(name, labels = {}) {
  if (!counters.has(name)) counters.set(name, new Map());
  const series = counters.get(name);
  const key = labelsKey(labels);

  if (!series.has(key)) {
    series.set(key, {
      labels: { ...labels },
      value: 0,
    });
  }

  return series.get(key);
}

function increment(name, labels = {}, value = 1) {
  if (!counterDefinitions[name]) return;
  const series = getCounterSeries(name, labels);
  series.value += Number(value) || 0;
}

function getHistogramSeries(name, labels = {}) {
  if (!histograms.has(name)) histograms.set(name, new Map());
  const series = histograms.get(name);
  const key = labelsKey(labels);

  if (!series.has(key)) {
    series.set(key, {
      labels: { ...labels },
      count: 0,
      sum: 0,
      buckets: histogramDefinitions[name].buckets.map(() => 0),
    });
  }

  return series.get(key);
}

function observe(name, value, labels = {}) {
  const definition = histogramDefinitions[name];
  const numericValue = Number(value);

  if (!definition || !Number.isFinite(numericValue)) return;

  const series = getHistogramSeries(name, labels);
  series.count += 1;
  series.sum += numericValue;

  definition.buckets.forEach((bucket, index) => {
    if (numericValue <= bucket) series.buckets[index] += 1;
  });
}

function setGauge(name, value) {
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) gauges.set(name, numericValue);
}

function escapeLabel(value) {
  return String(value)
    .replaceAll(String.fromCharCode(92), String.fromCharCode(92, 92))
    .replaceAll(String.fromCharCode(34), String.fromCharCode(92, 34))
    .replaceAll(String.fromCharCode(10), String.fromCharCode(92, 110));
}

function renderLabels(labels = {}) {
  const entries = Object.entries(labels);
  if (!entries.length) return "";

  return "{" + entries
    .map(([key, value]) => key + "=\"" + escapeLabel(value) + "\"")
    .join(",") + "}";
}

function formatMetricValue(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return String(Number(value));
}

function recordSignal(signal) {
  if (!signal) return;

  increment("perpsia_signals_total", {
    category: signal.category || "unknown",
    symbol: signal.symbol || "unknown",
  });
  observe("perpsia_signal_score", signal.score);
}

function recordCmcRequest(skill, latencyMs, status = "success") {
  increment("perpsia_cmc_requests_total", {
    skill: skill || "unknown",
    status,
  });
  observe("perpsia_cmc_latency_ms", latencyMs);
}

function recordCmcError(skill, error) {
  const kind = error?.code === "CIRCUIT_OPEN"
    ? "circuit_open"
    : Number(error?.response?.status) === 429
    ? "rate_limited"
    : "provider_or_network";

  increment("perpsia_cmc_errors_total", {
    skill: skill || "unknown",
    kind,
  });
}

function recordScan(source, status) {
  increment("perpsia_scans_total", {
    source: source || "unknown",
    status: status || "unknown",
  });
}

function structuredLog(level, event, fields = {}) {
  const payload = {
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function renderPrometheus() {
  const lines = [];

  for (const [name, definition] of Object.entries(counterDefinitions)) {
    lines.push("# HELP " + name + " " + definition.help);
    lines.push("# TYPE " + name + " counter");

    for (const series of counters.get(name)?.values() || []) {
      lines.push(name + renderLabels(series.labels) + " " + formatMetricValue(series.value));
    }
  }

  for (const [name, value] of gauges.entries()) {
    lines.push("# HELP " + name + " Perpsia gauge");
    lines.push("# TYPE " + name + " gauge");
    lines.push(name + " " + formatMetricValue(value));
  }

  for (const [name, definition] of Object.entries(histogramDefinitions)) {
    lines.push("# HELP " + name + " " + definition.help);
    lines.push("# TYPE " + name + " histogram");

    const series = histograms.get(name);
    for (const item of series?.values() || []) {
      definition.buckets.forEach((bucket, index) => {
        lines.push(
          name + "_bucket" +
          renderLabels({ ...item.labels, le: bucket }) +
          " " + formatMetricValue(item.buckets[index])
        );
      });

      lines.push(
        name + "_bucket" +
        renderLabels({ ...item.labels, le: "+Inf" }) +
        " " + formatMetricValue(item.count)
      );
      lines.push(name + "_sum" + renderLabels(item.labels) + " " + formatMetricValue(item.sum));
      lines.push(name + "_count" + renderLabels(item.labels) + " " + formatMetricValue(item.count));
    }
  }

  return lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
}

function getTelemetrySnapshot() {
  return {
    gauges: Object.fromEntries(gauges.entries()),
    counters: Object.fromEntries(
      [...counters.entries()].map(([name, series]) => [
        name,
        [...series.values()].map((item) => ({ ...item })),
      ])
    ),
  };
}

module.exports = {
  getTelemetrySnapshot,
  increment,
  observe,
  recordCmcError,
  recordCmcRequest,
  recordScan,
  recordSignal,
  renderPrometheus,
  setGauge,
  structuredLog,
};
