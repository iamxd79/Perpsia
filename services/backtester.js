// ==========================================
// PERPSIA PAPER TRADING BACKTESTER
// ==========================================

const axios = require("axios");
const { classifyCandidate } = require("./scannerV2");

const MAX_KLINE_LIMIT = 1500;
const FUNDING_LIMIT = 1000;
const OPEN_INTEREST_LIMIT = 500;
const DEFAULT_INTERVAL = "4h";
const DEFAULT_LOOKBACK_DAYS = 90;
const MAX_LOOKBACK_DAYS = 365;

function toFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (value === null || value === undefined || value === "") return null;

  const parsed = Number.parseFloat(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(symbol) {
  const normalized = String(symbol || "")
    .trim()
    .replace(/^$/, "")
    .toUpperCase();

  return normalized.endsWith("USDT") ? normalized : normalized + "USDT";
}

function parseTimestamp(value, label) {
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isFinite(time)) return time;
  }

  if (typeof value === "number") {
    const milliseconds = value < 100000000000 ? value * 1000 : value;
    if (Number.isFinite(milliseconds)) return milliseconds;
  }

  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) return parsed;

  throw new Error("Invalid " + label + ": " + String(value));
}

function intervalToMs(interval) {
  const intervals = {
    "1m": 60 * 1000,
    "3m": 3 * 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "2h": 2 * 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "8h": 8 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
  };

  return intervals[interval] || intervals[DEFAULT_INTERVAL];
}

function percentChange(current, previous) {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function latestAtOrBefore(rows, timestamp) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let low = 0;
  let high = rows.length - 1;
  let result = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle];

    if (row.timestamp <= timestamp) {
      result = row;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

function minPast(candles, index, field, count) {
  const values = [];
  const start = Math.max(0, index - count);

  for (let cursor = start; cursor < index; cursor++) {
    const value = toFiniteNumber(candles[cursor]?.[field]);
    if (value !== null) values.push(value);
  }

  return values.length ? Math.min(...values) : null;
}

function maxPast(candles, index, field, count) {
  const values = [];
  const start = Math.max(0, index - count);

  for (let cursor = start; cursor < index; cursor++) {
    const value = toFiniteNumber(candles[cursor]?.[field]);
    if (value !== null) values.push(value);
  }

  return values.length ? Math.max(...values) : null;
}

function extractNumbers(value) {
  const text = String(value || "");
  const numbers = [];
  let buffer = "";

  const flush = () => {
    if (!buffer || buffer === "-" || buffer === ".") {
      buffer = "";
      return;
    }

    const parsed = Number(buffer);
    if (Number.isFinite(parsed)) numbers.push(parsed);
    buffer = "";
  };

  for (const character of text) {
    const isDigit = character >= "0" && character <= "9";
    const isDot = character === ".";
    const isMinus = character === "-" && buffer.length === 0;

    if (isDigit || isDot || isMinus) {
      buffer += character;
    } else {
      flush();
    }
  }

  flush();
  return numbers;
}

function normalizeDirection(direction) {
  const value = String(direction || "").toLowerCase();
  if (value.includes("short") || value === "bearish") return "short";
  if (value.includes("long") || value === "bullish") return "long";
  return null;
}

function calculatePnlPercent(direction, entryPrice, exitPrice) {
  if (!entryPrice || !exitPrice) return 0;
  return direction === "short"
    ? ((entryPrice - exitPrice) / entryPrice) * 100
    : ((exitPrice - entryPrice) / entryPrice) * 100;
}

function emptyStats() {
  return {
    totalTrades: 0,
    winners: 0,
    losers: 0,
    breakeven: 0,
    winRate: 0,
    avgWin: 0,
    avgLoss: 0,
    profitFactor: 0,
    maxDrawdown: 0,
    totalReturn: 0,
    grossProfit: 0,
    grossLoss: 0,
  };
}

class Backtester {
  constructor(options = {}) {
    this.httpClient = options.httpClient || axios;
    this.futuresBaseUrl = options.futuresBaseUrl || process.env.BACKTEST_FUTURES_BASE_URL || "https://fapi.binance.com";
    this.defaultInterval = options.interval || DEFAULT_INTERVAL;
    this.defaultLookbackDays = options.defaultLookbackDays || DEFAULT_LOOKBACK_DAYS;
    this.maxLookbackDays = options.maxLookbackDays || MAX_LOOKBACK_DAYS;
    this.signalAnalyzer = options.signalAnalyzer || null;
  }

  async getHistoricalCandles(
    symbol,
    interval = this.defaultInterval,
    limit = MAX_KLINE_LIMIT,
    startTime = null,
    endTime = null
  ) {
    const marketSymbol = normalizeSymbol(symbol);
    const boundedLimit = Math.min(Math.max(Number(limit) || MAX_KLINE_LIMIT, 1), MAX_KLINE_LIMIT);
    const hasRange = Number.isFinite(startTime) && Number.isFinite(endTime);
    const intervalMs = intervalToMs(interval);
    const candles = [];
    let cursor = startTime;
    let remaining = hasRange ? Number.POSITIVE_INFINITY : boundedLimit;

    while (hasRange ? cursor <= endTime : remaining > 0) {
      const requestLimit = hasRange ? MAX_KLINE_LIMIT : Math.min(remaining, MAX_KLINE_LIMIT);
      const params = {
        symbol: marketSymbol,
        interval,
        limit: requestLimit,
      };

      if (hasRange) {
        params.startTime = cursor;
        params.endTime = endTime;
      }

      const response = await this.httpClient.get(
        this.futuresBaseUrl + "/fapi/v1/klines",
        { params, timeout: 15000 }
      );
      const rows = Array.isArray(response.data) ? response.data : [];

      for (const row of rows) {
        const timestamp = toFiniteNumber(row?.[0]);
        const open = toFiniteNumber(row?.[1]);
        const high = toFiniteNumber(row?.[2]);
        const low = toFiniteNumber(row?.[3]);
        const close = toFiniteNumber(row?.[4]);

        if ([timestamp, open, high, low, close].every((value) => value !== null)) {
          candles.push({
            timestamp,
            open,
            high,
            low,
            close,
            volume: toFiniteNumber(row?.[7]) || 0,
          });
        }
      }

      if (!hasRange || rows.length === 0 || rows.length < requestLimit) break;

      const lastTimestamp = toFiniteNumber(rows[rows.length - 1]?.[0]);
      if (lastTimestamp === null || lastTimestamp >= endTime) break;

      cursor = lastTimestamp + intervalMs;
      if (!hasRange) remaining -= rows.length;
    }

    const unique = new Map();
    for (const candle of candles) unique.set(candle.timestamp, candle);
    return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  async getHistoricalFunding(symbol, startTime, endTime) {
    const marketSymbol = normalizeSymbol(symbol);
    const rows = [];
    let cursor = startTime;

    while (cursor <= endTime) {
      const response = await this.httpClient.get(
        this.futuresBaseUrl + "/fapi/v1/fundingRate",
        {
          params: {
            symbol: marketSymbol,
            startTime: cursor,
            endTime,
            limit: FUNDING_LIMIT,
          },
          timeout: 15000,
        }
      );
      const batch = Array.isArray(response.data) ? response.data : [];
      if (batch.length === 0) break;

      for (const row of batch) {
        const timestamp = toFiniteNumber(row?.fundingTime);
        const rate = toFiniteNumber(row?.fundingRate);
        if (timestamp !== null && rate !== null) rows.push({ timestamp, rate });
      }

      if (batch.length < FUNDING_LIMIT) break;
      const lastTimestamp = toFiniteNumber(batch[batch.length - 1]?.fundingTime);
      if (lastTimestamp === null || lastTimestamp >= endTime) break;
      cursor = lastTimestamp + 1;
    }

    const unique = new Map();
    for (const row of rows) unique.set(row.timestamp, row);
    return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  async getHistoricalOpenInterest(symbol, startTime, endTime, period = DEFAULT_INTERVAL) {
    const marketSymbol = normalizeSymbol(symbol);
    const rows = [];
    let cursor = startTime;

    while (cursor <= endTime) {
      const response = await this.httpClient.get(
        this.futuresBaseUrl + "/futures/data/openInterestHist",
        {
          params: {
            symbol: marketSymbol,
            period,
            startTime: cursor,
            endTime,
            limit: OPEN_INTEREST_LIMIT,
          },
          timeout: 15000,
        }
      );
      const batch = Array.isArray(response.data) ? response.data : [];
      if (batch.length === 0) break;

      for (const row of batch) {
        const timestamp = toFiniteNumber(row?.timestamp);
        const value = toFiniteNumber(row?.sumOpenInterestValue ?? row?.sumOpenInterest);
        if (timestamp !== null && value !== null) rows.push({ timestamp, value });
      }

      if (batch.length < OPEN_INTEREST_LIMIT) break;
      const lastTimestamp = toFiniteNumber(batch[batch.length - 1]?.timestamp);
      if (lastTimestamp === null || lastTimestamp >= endTime) break;
      cursor = lastTimestamp + 1;
    }

    const unique = new Map();
    for (const row of rows) unique.set(row.timestamp, row);
    return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  async getHistoricalData(symbol, startTime, endTime, options = {}) {
    const interval = options.interval || this.defaultInterval;
    const period = options.oiPeriod || interval;
    const onProgress = options.onProgress || (async () => {});
    const tasks = [
      this.getHistoricalCandles(symbol, interval, MAX_KLINE_LIMIT, startTime, endTime),
      this.getHistoricalFunding(symbol, startTime, endTime),
      this.getHistoricalOpenInterest(symbol, startTime, endTime, period),
    ];

    await onProgress({ percent: 5, stage: "Historical Data", message: "Fetching futures candles, funding and open interest..." });
    const results = await Promise.allSettled(tasks);
    const errors = [];

    const candles = results[0].status === "fulfilled" ? results[0].value : [];
    const funding = results[1].status === "fulfilled" ? results[1].value : [];
    const openInterest = results[2].status === "fulfilled" ? results[2].value : [];

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const names = ["candles", "funding", "open interest"];
        errors.push(names[index] + ": " + result.reason.message);
      }
    });

    await onProgress({ percent: 20, stage: "Historical Data", message: "Loaded " + candles.length + " candles, " + funding.length + " funding points and " + openInterest.length + " open-interest points." });

    return { candles, funding, openInterest, errors, interval, period };
  }

  buildHistoricalSignal(symbol, candleIndex, data) {
    const candle = data.candles[candleIndex];
    const prior24 = data.candles[candleIndex - 6];
    const prior72 = data.candles[candleIndex - 18];
    const fundingRow = latestAtOrBefore(data.funding, candle.timestamp);
    const oiRow = latestAtOrBefore(data.openInterest, candle.timestamp);
    const priorOiRow = prior24 ? latestAtOrBefore(data.openInterest, prior24.timestamp) : null;

    const price = candle?.close ?? null;
    const priceChange = prior24 ? percentChange(price, prior24.close) : null;
    const oiChange = oiRow && priorOiRow ? percentChange(oiRow.value, priorOiRow.value) : null;
    const funding = fundingRow ? fundingRow.rate * 100 : null;
    const support = minPast(data.candles, candleIndex, "low", 6);
    const resistance = maxPast(data.candles, candleIndex, "high", 6);

    const priorClose6 = candleIndex >= 6 ? data.candles[candleIndex - 6].close : null;
    const priorClose18 = candleIndex >= 18 ? data.candles[candleIndex - 18].close : null;
    const bullishVotes = [
      priorClose6 !== null && price > priorClose6,
      priorClose18 !== null && price > priorClose18,
    ].filter(Boolean).length;
    const bearishVotes = [
      priorClose6 !== null && price < priorClose6,
      priorClose18 !== null && price < priorClose18,
    ].filter(Boolean).length;

    const range = resistance !== null && support !== null ? resistance - support : null;
    const rangePosition = range && range > 0 ? (price - support) / range : 0.5;
    const earlyTransition =
      resistance !== null && price >= resistance * 0.995 && priceChange !== null && priceChange > 0;

    let perpAnalysis = "neutral perp structure";
    if (priceChange !== null && oiChange !== null) {
      if (priceChange >= 0 && oiChange >= 0) {
        perpAnalysis = "price_up_oi_up; spot buying confirms price strength";
      } else if (priceChange < 0 && oiChange >= 0) {
        perpAnalysis = "price_down_oi_up; spot selling confirms price weakness";
      } else if (priceChange > 0) {
        perpAnalysis = "continuation to the upside";
      } else if (priceChange < 0) {
        perpAnalysis = "continuation to the downside";
      }
    }

    const mtfAnalysis = bullishVotes >= 2
      ? "full bullish bias"
      : bearishVotes >= 2
      ? "full bearish bias"
      : "mixed multi-timeframe bias";
    const orderbookAnalysis = rangePosition >= 0.6
      ? "bid support; buyers are defending"
      : rangePosition <= 0.4
      ? "ask overhang; sellers are capping"
      : "balanced orderbook";
    const accumulationAnalysis = earlyTransition
      ? "accumulation breakout transition"
      : "range accumulation";

    const makePack = (analysis) => ({
      result: {
        data: {
          data: {
            current_price: price,
            price_change_24h: priceChange,
            open_interest_change_percent: oiChange,
            funding_percent: funding,
            support,
            resistance,
            decision_report: {
              conclusion: "Historical replay snapshot",
              analysis,
            },
          },
        },
      },
    });

    const packs = {
      accumulation: makePack(accumulationAnalysis),
      perp: makePack(perpAnalysis),
      orderbook: makePack(orderbookAnalysis),
      mtf: makePack(mtfAnalysis),
    };

    return classifyCandidate(symbol, packs);
  }

  async analyzeAssetHistorical(symbol, timestamp, context = {}) {
    if (this.signalAnalyzer) {
      return this.signalAnalyzer(symbol, timestamp, context);
    }

    if (!context.data || context.candleIndex === undefined) {
      throw new Error("Historical analyzer requires aligned market data.");
    }

    return this.buildHistoricalSignal(symbol, context.candleIndex, context.data);
  }

  findExitCandle(candles, entryIndex, direction, entryPrice, stop, tp1, tp2) {
    const normalizedDirection = normalizeDirection(direction);
    if (!normalizedDirection) return null;

    for (let index = entryIndex + 1; index < candles.length; index++) {
      const candle = candles[index];
      const stopHit = normalizedDirection === "long"
        ? candle.low <= stop
        : candle.high >= stop;
      const tp1Hit = normalizedDirection === "long"
        ? candle.high >= tp1
        : candle.low <= tp1;
      const tp2Hit = Number.isFinite(tp2) && (normalizedDirection === "long"
        ? candle.high >= tp2
        : candle.low <= tp2);

      if (stopHit) {
        return {
          index,
          time: candle.timestamp,
          price: stop,
          reason: "STOP_HIT",
        };
      }

      if (tp1Hit) {
        return {
          index,
          time: candle.timestamp,
          price: tp1,
          reason: "TP1_HIT",
        };
      }

      if (tp2Hit) {
        return {
          index,
          time: candle.timestamp,
          price: tp2,
          reason: "TP2_HIT",
        };
      }
    }

    const finalCandle = candles[candles.length - 1];
    if (!finalCandle) return null;

    return {
      index: candles.length - 1,
      time: finalCandle.timestamp,
      price: finalCandle.close,
      reason: "END_OF_DATA",
    };
  }

  resolveEntryPrice(entry, currentPrice) {
    const direct = typeof entry === "number" ? toFiniteNumber(entry) : null;
    if (direct !== null && direct > 0) return direct;

    const values = extractNumbers(entry).filter((value) => value > 0);
    if (!values.length) return currentPrice;
    if (values.length === 1) return values[0];

    const low = Math.min(...values);
    const high = Math.max(...values);
    return currentPrice >= low && currentPrice <= high
      ? currentPrice
      : (low + high) / 2;
  }

  simulateTrade(candles, entryIndex, entry, tp1, tp2, stop, direction) {
    const normalizedDirection = normalizeDirection(direction);
    const entryPrice = this.resolveEntryPrice(entry, candles[entryIndex]?.close);
    const firstTarget = toFiniteNumber(tp1);
    const secondTarget = toFiniteNumber(tp2);
    const stopPrice = toFiniteNumber(stop);

    if (!normalizedDirection || !entryPrice || !firstTarget || !stopPrice) return null;

    const validLevels = normalizedDirection === "long"
      ? stopPrice < entryPrice && firstTarget > entryPrice
      : stopPrice > entryPrice && firstTarget < entryPrice;
    if (!validLevels) return null;

    const outcome = this.findExitCandle(
      candles,
      entryIndex,
      normalizedDirection,
      entryPrice,
      stopPrice,
      firstTarget,
      secondTarget
    );
    if (!outcome) return null;

    return {
      entryTime: candles[entryIndex].timestamp,
      entryPrice: round(entryPrice),
      exitTime: outcome.time,
      exitPrice: round(outcome.price),
      exitReason: outcome.reason,
      duration: outcome.time - candles[entryIndex].timestamp,
      pnlPercent: round(calculatePnlPercent(normalizedDirection, entryPrice, outcome.price), 4),
      status: outcome.price === stopPrice ? "loss" : outcome.reason === "END_OF_DATA" ? "open" : "win",
      direction: normalizedDirection,
      exitIndex: outcome.index,
    };
  }

  async backtest(symbol, startDate, endDate, options = {}) {
    let startTime;
    let endTime;

    if (typeof startDate === "number" && endDate === undefined) {
      const lookbackCandles = Math.max(1, Math.floor(startDate));
      endTime = Date.now();
      startTime = endTime - lookbackCandles * intervalToMs(this.defaultInterval);
    } else {
      endTime = endDate === undefined ? Date.now() : parseTimestamp(endDate, "end date");
      startTime = startDate === undefined ? endTime - this.defaultLookbackDays * 24 * 60 * 60 * 1000 : parseTimestamp(startDate, "start date");
    }

    if (endTime <= startTime) throw new Error("End date must be after start date.");

    const rangeDays = (endTime - startTime) / (24 * 60 * 60 * 1000);
    if (rangeDays > this.maxLookbackDays) {
      throw new Error("Backtest range cannot exceed " + this.maxLookbackDays + " days.");
    }

    const onProgress = options.onProgress || (async () => {});
    const data = await this.getHistoricalData(symbol, startTime, endTime, {
      interval: options.interval || this.defaultInterval,
      oiPeriod: options.oiPeriod || options.interval || this.defaultInterval,
      onProgress,
    });

    if (!data.candles.length) {
      return {
        symbol: String(symbol).toUpperCase(),
        status: "error",
        message: "Historical market data unavailable." + (data.errors.length ? " " + data.errors.join("; ") : ""),
        trades: [],
        stats: emptyStats(),
        dataQuality: { fundingPoints: data.funding.length, openInterestPoints: data.openInterest.length, errors: data.errors },
      };
    }

    const trades = [];
    const allowOverlapping = options.allowOverlapping === true;
    let nextAvailableIndex = 18;

    for (let index = 18; index < data.candles.length; index++) {
      if (!allowOverlapping && index < nextAvailableIndex) continue;

      await onProgress({
        percent: 20 + Math.round(((index - 18) / Math.max(data.candles.length - 18, 1)) * 75),
        stage: "Historical Replay",
        message: "Replaying candle " + (index - 17) + " of " + (data.candles.length - 17) + "...",
      });

      const candle = data.candles[index];
      const signal = await this.analyzeAssetHistorical(symbol, candle.timestamp, {
        candleIndex: index,
        data,
      });

      if (!signal?.isActionable) continue;

      const trade = this.simulateTrade(
        data.candles,
        index,
        signal.entry,
        signal.tp1,
        signal.tp2,
        signal.stop,
        signal.direction
      );
      if (!trade) continue;

      trades.push({
        symbol: String(symbol).toUpperCase(),
        score: signal.score,
        marketState: signal.marketState,
        entryTime: trade.entryTime,
        entryPrice: trade.entryPrice,
        exitTime: trade.exitTime,
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,
        pnlPercent: trade.pnlPercent,
        duration: trade.duration,
        direction: trade.direction,
        status: trade.status,
      });

      if (!allowOverlapping) nextAvailableIndex = trade.exitIndex + 1;
    }

    await onProgress({ percent: 100, stage: "Historical Replay", message: "Backtest complete." });

    return {
      symbol: String(symbol).toUpperCase(),
      status: data.errors.length ? "partial" : "complete",
      message: data.errors.length ? "Completed with missing historical series." : "Historical replay completed.",
      candleCount: data.candles.length,
      dateRange: {
        start: new Date(data.candles[0].timestamp),
        end: new Date(data.candles[data.candles.length - 1].timestamp),
      },
      dataQuality: {
        fundingPoints: data.funding.length,
        openInterestPoints: data.openInterest.length,
        errors: data.errors,
      },
      trades,
      stats: this.calculateMetrics(trades),
    };
  }

  calculateMetrics(trades) {
    if (!Array.isArray(trades) || trades.length === 0) return emptyStats();

    const winners = trades.filter((trade) => trade.pnlPercent > 0);
    const losers = trades.filter((trade) => trade.pnlPercent < 0);
    const breakeven = trades.filter((trade) => trade.pnlPercent === 0);
    const grossProfit = winners.reduce((sum, trade) => sum + trade.pnlPercent, 0);
    const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.pnlPercent, 0));
    const avgWin = winners.length ? grossProfit / winners.length : 0;
    const avgLoss = losers.length ? grossLoss / losers.length : 0;

    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;

    for (const trade of trades) {
      equity *= 1 + trade.pnlPercent / 100;
      peak = Math.max(peak, equity);
      const drawdown = peak ? ((peak - equity) / peak) * 100 : 0;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    return {
      totalTrades: trades.length,
      winners: winners.length,
      losers: losers.length,
      breakeven: breakeven.length,
      winRate: round((winners.length / trades.length) * 100, 2),
      avgWin: round(avgWin, 4),
      avgLoss: round(avgLoss, 4),
      profitFactor: grossLoss ? round(grossProfit / grossLoss, 4) : grossProfit ? null : 0,
      maxDrawdown: round(maxDrawdown, 4),
      totalReturn: round((equity - 1) * 100, 4),
      grossProfit: round(grossProfit, 4),
      grossLoss: round(grossLoss, 4),
    };
  }
}

module.exports = {
  Backtester,
  normalizeSymbol,
  latestAtOrBefore,
  calculatePnlPercent,
};

