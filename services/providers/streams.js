"use strict";

const { normalizeEvidence } = require("./evidence");

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function symbolOf(value) {
  return String(value || "").trim().toUpperCase().replace(/^\$/, "").replace(/(USDT|USDC|USD)$/, "");
}

function depth(bids, asks) {
  const bidVolume = (bids || []).reduce((sum, level) => sum + (number(level?.[0] || level?.px) || 0) * (number(level?.[1] || level?.sz) || 0), 0);
  const askVolume = (asks || []).reduce((sum, level) => sum + (number(level?.[0] || level?.px) || 0) * (number(level?.[1] || level?.sz) || 0), 0);
  const total = bidVolume + askVolume;
  return {
    bidVolume,
    askVolume,
    imbalance: total ? (bidVolume - askVolume) / total : null,
  };
}

const streamDefinitions = {
  binance: {
    provider: "binance",
    url: (symbol) => "wss://fstream.binance.com/stream?streams=" + symbolOf(symbol).toLowerCase() + "usdt@markPrice@1s/" + symbolOf(symbol).toLowerCase() + "usdt@depth20@100ms/" + symbolOf(symbol).toLowerCase() + "usdt@ticker",
    subscribe: null,
    normalize: (message, state, symbol) => {
      const data = message?.data || message;
      if (data?.e === "markPriceUpdate") {
        state.price = number(data.p);
        state.funding = number(data.r);
        state.timestamp = number(data.E) || Date.now();
      }
      if (data?.e === "depthUpdate") {
        state.bids = data.b || [];
        state.asks = data.a || [];
      }
      if (data?.e === "24hrTicker") {
        state.price = number(data.c) || state.price;
        state.volume = number(data.q) || number(data.v);
        state.priceChange = number(data.P);
        state.timestamp = number(data.E) || state.timestamp || Date.now();
      }
      if (state.price === null || state.price === undefined) return null;
      return {
        provider: "binance",
        symbol: symbolOf(symbol),
        marketType: "perpetual",
        timestamp: state.timestamp || Date.now(),
        price: state.price,
        perpPrice: state.price,
        volume: state.volume,
        funding: state.funding,
        priceChange: state.priceChange,
        orderbook: depth(state.bids, state.asks),
        status: "ok",
        metadata: { transport: "WebSocket", feed: "Binance Futures public stream" },
      };
    },
  },
  bybit: {
    provider: "bybit",
    url: () => "wss://stream.bybit.com/v5/public/linear",
    subscribe: (symbol) => ({
      op: "subscribe",
      args: ["tickers." + symbolOf(symbol) + "USDT", "orderbook.25." + symbolOf(symbol) + "USDT"],
    }),
    normalize: (message, state, symbol) => {
      const topic = String(message?.topic || "");
      const data = message?.data || {};
      if (topic.startsWith("tickers.")) {
        state.price = number(data.lastPrice);
        state.funding = number(data.fundingRate);
        state.volume = number(data.turnover24h) || number(data.volume24h);
        state.openInterest = number(data.openInterest);
        state.priceChange = number(data.price24hPcnt) === null ? null : number(data.price24hPcnt) * 100;
        state.timestamp = number(message?.ts) || Date.now();
      }
      if (topic.startsWith("orderbook.")) {
        state.bids = data.b || [];
        state.asks = data.a || [];
      }
      if (state.price === null || state.price === undefined) return null;
      return {
        provider: "bybit",
        symbol: symbolOf(symbol),
        marketType: "perpetual",
        timestamp: state.timestamp || Date.now(),
        price: state.price,
        perpPrice: state.price,
        volume: state.volume,
        openInterest: state.openInterest,
        funding: state.funding,
        priceChange: state.priceChange,
        orderbook: depth(state.bids, state.asks),
        status: "ok",
        metadata: { transport: "WebSocket", feed: "Bybit V5 public stream" },
      };
    },
  },
  okx: {
    provider: "okx",
    url: () => "wss://ws.okx.com:8443/ws/v5/public",
    subscribe: (symbol) => ({
      op: "subscribe",
      args: [
        { channel: "tickers", instId: symbolOf(symbol) + "-USDT-SWAP" },
        { channel: "books5", instId: symbolOf(symbol) + "-USDT-SWAP" },
        { channel: "funding-rate", instId: symbolOf(symbol) + "-USDT-SWAP" },
      ],
    }),
    normalize: (message, state, symbol) => {
      const channel = message?.arg?.channel;
      const data = message?.data?.[0] || {};
      if (channel === "tickers") {
        state.price = number(data.last) || state.price;
        state.volume = number(data.volCcy24h) || number(data.vol24h);
        state.timestamp = number(data.ts) || Date.now();
      }
      if (channel === "funding-rate") state.funding = number(data.fundingRate);
      if (channel === "books5") {
        state.bids = data.bids || [];
        state.asks = data.asks || [];
      }
      if (state.price === null || state.price === undefined) return null;
      return {
        provider: "okx",
        symbol: symbolOf(symbol),
        marketType: "perpetual",
        timestamp: state.timestamp || Date.now(),
        price: state.price,
        perpPrice: state.price,
        volume: state.volume,
        funding: state.funding,
        orderbook: depth(state.bids, state.asks),
        status: "ok",
        metadata: { transport: "WebSocket", feed: "OKX public stream" },
      };
    },
  },
  hyperliquid: {
    provider: "hyperliquid",
    url: () => "wss://api.hyperliquid.xyz/ws",
    subscribe: (symbol) => [
      { method: "subscribe", subscription: { type: "allMids" } },
      { method: "subscribe", subscription: { type: "l2Book", coin: symbolOf(symbol) } },
    ],
    normalize: (message, state, symbol) => {
      const channel = message?.channel;
      const data = message?.data || {};
      if (channel === "allMids") {
        state.price = number(data.mids?.[symbolOf(symbol)]);
        state.timestamp = Date.now();
      }
      if (channel === "l2Book") {
        const levels = data.levels || [];
        state.bids = levels[0] || [];
        state.asks = levels[1] || [];
        state.price = state.price || number(state.bids[0]?.px) || number(state.asks[0]?.px);
      }
      if (state.price === null || state.price === undefined) return null;
      return {
        provider: "hyperliquid",
        symbol: symbolOf(symbol),
        marketType: "perpetual",
        timestamp: state.timestamp || Date.now(),
        price: state.price,
        perpPrice: state.price,
        orderbook: depth(state.bids, state.asks),
        status: "ok",
        metadata: { transport: "WebSocket", feed: "Hyperliquid public stream" },
      };
    },
  },
};

function getStreamDefinition(provider) {
  return streamDefinitions[String(provider || "").toLowerCase()] || null;
}

function openPublicStream(provider, symbol, onEvidence) {
  const definition = getStreamDefinition(provider);
  if (!definition) throw new Error("No public stream definition for " + provider);
  if (typeof WebSocket !== "function") {
    throw new Error("WebSocket is not available in this Node runtime");
  }
  const socket = new WebSocket(definition.url(symbol));
  const state = {};
  socket.addEventListener("open", () => {
    const subscription = definition.subscribe?.(symbol);
    if (!subscription) return;
    for (const message of (Array.isArray(subscription) ? subscription : [subscription])) {
      socket.send(JSON.stringify(message));
    }
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data || ""));
      const evidence = definition.normalize(message, state, symbol);
      if (evidence && typeof onEvidence === "function") {
        onEvidence(normalizeEvidence(evidence));
      }
    } catch {
      // A malformed stream message is isolated to this feed.
    }
  });
  return {
    provider: definition.provider,
    symbol: symbolOf(symbol),
    socket,
    close: () => socket.close(),
  };
}

function listPublicStreams() {
  return Object.values(streamDefinitions).map((definition) => ({
    provider: definition.provider,
    transport: "WebSocket",
    url: definition.url("BTC"),
    available: typeof WebSocket === "function",
  }));
}

module.exports = {
  getStreamDefinition,
  listPublicStreams,
  openPublicStream,
};
