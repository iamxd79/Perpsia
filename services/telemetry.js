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
};

const counters = new Map();
const histograms = new Map();
const gauges = new Map([
  ["perpsia_up", 1],
  ["perpsia_open_signals", 0],
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
