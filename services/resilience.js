// ==========================================
// PERPSIA RESILIENCE: RETRIES + CIRCUIT BREAKER
// ==========================================

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableError(error) {
  const status = Number(
    error?.status ??
    error?.statusCode ??
    error?.response?.status ??
    error?.cause?.status
  );

  if ([408, 425, 429].includes(status) || (status >= 500 && status <= 599)) {
    return true;
  }

  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  if (
    [
      "ECONNABORTED",
      "ECONNRESET",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(code)
  ) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return /timeout|timed out|socket hang up|network error|fetch failed|temporarily unavailable|connection reset|service unavailable/.test(message);
}

function createCircuitOpenError(name) {
  const error = new Error("Circuit breaker is OPEN for " + name);
  error.code = "CIRCUIT_OPEN";
  error.retryable = false;
  return error;
}

class CircuitBreaker {
  constructor(threshold = 5, timeout = 120000, options = {}) {
    this.name = options.name || "external provider";
    this.failures = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = "CLOSED";
    this.lastFailureTime = null;
    this.halfOpenProbe = false;
    this.failurePredicate = options.failurePredicate || isRetryableError;
  }

  async execute(fn) {
    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.lastFailureTime || 0);
      if (elapsed <= this.timeout) {
        throw createCircuitOpenError(this.name);
      }

      this.state = "HALF_OPEN";
      this.halfOpenProbe = false;
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenProbe) {
        throw createCircuitOpenError(this.name);
      }
      this.halfOpenProbe = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  onSuccess() {
    this.failures = 0;
    this.state = "CLOSED";
    this.lastFailureTime = null;
    this.halfOpenProbe = false;
  }

  onFailure(error) {
    this.halfOpenProbe = false;

    if (!this.failurePredicate(error)) {
      if (this.state === "HALF_OPEN") this.state = "CLOSED";
      return;
    }

    this.failures += 1;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.threshold) {
      this.state = "OPEN";
    }
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      threshold: this.threshold,
      timeoutMs: this.timeout,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

async function withRetries(fn, options = {}) {
  const retries = Math.max(0, Number(options.retries ?? 2));
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs ?? 700));
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs ?? 5000));
  const retryPredicate = options.retryPredicate || isRetryableError;
  let attempt = 0;

  while (true) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= retries || !retryPredicate(error)) {
        throw error;
      }

      attempt += 1;
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.25)));
      const delayMs = exponential + jitter;

      await options.onRetry?.({
        attempt,
        retries,
        delayMs,
        error,
      });
      await sleep(delayMs);
    }
  }
}

const cmcCircuitBreaker = new CircuitBreaker(5, 120000, {
  name: "CMC Skill Hub",
});

async function executeWithResilience(fn, options = {}) {
  const breaker = options.breaker || cmcCircuitBreaker;
  return breaker.execute(() =>
    withRetries(fn, {
      retries: options.retries ?? 2,
      baseDelayMs: options.baseDelayMs ?? 700,
      maxDelayMs: options.maxDelayMs ?? 5000,
      retryPredicate: options.retryPredicate || isRetryableError,
      onRetry: options.onRetry,
    })
  );
}

module.exports = {
  CircuitBreaker,
  cmcCircuitBreaker,
  executeWithResilience,
  isRetryableError,
  sleep,
  withRetries,
};
