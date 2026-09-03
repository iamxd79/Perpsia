// ==========================================
// PERPSIA PAPER TRADING BACKTESTER
// ==========================================

const axios = require("axios");

class Backtester {
  constructor() {
    this.binanceBaseUrl = "https://api.binance.com/api/v3";
  }

  /**
   * Fetch historical OHLCV data for a symbol
   */
  async getHistoricalCandles(symbol, interval = "4h", limit = 500) {
    try {
      const response = await axios.get(`${this.binanceBaseUrl}/klines`, {
        params: {
          symbol: `${symbol}USDT`,
          interval,
          limit,
        },
        timeout: 10000,
      });

      return response.data.map((candle) => ({
        timestamp: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[7]),
      }));
    } catch (error) {
      console.error(`Failed to fetch candles for ${symbol}:`, error.message);
      return [];
    }
  }

  /**
   * Simulate trades based on signal entry, TP, and stop
   */
  simulateTrade(candles, entryIndex, entry, tp1, tp2, stop, direction) {
    const trades = [];
    let currentCandle = entryIndex;

    while (currentCandle < candles.length) {
      const candle = candles[currentCandle];

      // Check if stop hit
      if (direction === "long" && candle.low <= stop) {
        return {
          entryTime: candles[entryIndex].timestamp,
          entryPrice: entry,
          exitTime: candle.timestamp,
          exitPrice: stop,
          exitReason: "STOP_HIT",
          duration: candle.timestamp - candles[entryIndex].timestamp,
          pnlPercent: ((stop - entry) / entry) * 100,
          status: "loss",
        };
      }

      if (direction === "short" && candle.high >= stop) {
        return {
          entryTime: candles[entryIndex].timestamp,
          entryPrice: entry,
          exitTime: candle.timestamp,
          exitPrice: stop,
          exitReason: "STOP_HIT",
          duration: candle.timestamp - candles[entryIndex].timestamp,
          pnlPercent: ((entry - stop) / entry) * 100,
          status: "loss",
        };
      }

      // Check if TP1 hit
      if (direction === "long" && candle.high >= tp1) {
        return {
          entryTime: candles[entryIndex].timestamp,
          entryPrice: entry,
          exitTime: candle.timestamp,
          exitPrice: tp1,
          exitReason: "TP1_HIT",
          duration: candle.timestamp - candles[entryIndex].timestamp,
          pnlPercent: ((tp1 - entry) / entry) * 100,
          status: "win",
        };
      }

      if (direction === "short" && candle.low <= tp1) {
        return {
          entryTime: candles[entryIndex].timestamp,
          entryPrice: entry,
          exitTime: candle.timestamp,
          exitPrice: tp1,
          exitReason: "TP1_HIT",
          duration: candle.timestamp - candles[entryIndex].timestamp,
          pnlPercent: ((entry - tp1) / entry) * 100,
          status: "win",
        };
      }

      // Check if TP2 hit
      if (direction === "long" && candle.high >= tp2) {
        return {
          entryTime: candles[entryIndex].timestamp,
          entryPrice: entry,
          exitTime: candle.timestamp,
          exitPrice: tp2,
          exitReason: "TP2_HIT",
          duration: candle.timestamp - candles[entryIndex].timestamp,
          pnlPercent: ((tp2 - entry) / entry) * 100,
          status: "win",
        };
      }

      if (direction === "short" && candle.low <= tp2) {
        return {
          entryTime: candles[entryIndex].timestamp,
          entryPrice: entry,
          exitTime: candle.timestamp,
          exitPrice: tp2,
          exitReason: "TP2_HIT",
          duration: candle.timestamp - candles[entryIndex].timestamp,
          pnlPercent: ((entry - tp2) / entry) * 100,
          status: "win",
        };
      }

      currentCandle++;
    }

    // No exit found
    return null;
  }

  /**
   * Run backtest for a symbol over historical data
   */
  async backtest(symbol, lookbackCandles = 500) {
    console.log(
      `[Backtester] Starting backtest for $${symbol} (last ${lookbackCandles} candles)...`
    );

    const candles = await this.getHistoricalCandles(symbol, "4h", lookbackCandles);

    if (candles.length === 0) {
      return {
        symbol,
        status: "error",
        message: "No historical data available",
        trades: [],
        stats: null,
      };
    }

    // For now, return structure (full backtest requires signal replay)
    return {
      symbol,
      status: "ready",
      message: "Backtester ready. Requires signal history for replay.",
      candleCount: candles.length,
      dateRange: {
        start: new Date(candles[0].timestamp),
        end: new Date(candles[candles.length - 1].timestamp),
      },
      trades: [],
      stats: {
        totalTrades: 0,
        winners: 0,
        losers: 0,
        winRate: "N/A",
        avgWin: "N/A",
        avgLoss: "N/A",
        profitFactor: "N/A",
        maxDrawdown: "N/A",
      },
    };
  }

  /**
   * Calculate performance metrics from trades
   */
  calculateMetrics(trades) {
    if (trades.length === 0) {
      return {
        totalTrades: 0,
        winners: 0,
        losers: 0,
        winRate: "0%",
        avgWin: "N/A",
        avgLoss: "N/A",
        profitFactor: "N/A",
        maxDrawdown: "N/A",
      };
    }

    const winners = trades.filter((t) => t.status === "win");
    const losers = trades.filter((t) => t.status === "loss");

    const avgWin =
      winners.length > 0
        ? winners.reduce((sum, t) => sum + t.pnlPercent, 0) / winners.length
        : 0;

    const avgLoss =
      losers.length > 0
        ? losers.reduce((sum, t) => sum + t.pnlPercent, 0) / losers.length
        : 0;

    const profitFactor =
      avgLoss !== 0 ? Math.abs((avgWin * winners.length) / (avgLoss * losers.length)) : 0;

    return {
      totalTrades: trades.length,
      winners: winners.length,
      losers: losers.length,
      winRate: `${((winners.length / trades.length) * 100).toFixed(1)}%`,
      avgWin: `${avgWin.toFixed(2)}%`,
      avgLoss: `${avgLoss.toFixed(2)}%`,
      profitFactor: profitFactor.toFixed(2),
      maxDrawdown: "N/A", // Requires equity curve tracking
    };
  }
}

module.exports = {
  Backtester,
};