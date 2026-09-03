const axios = require("axios");


const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a3e8f5a7d";


const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_MIN_VALUE_USD = 1000000;
const DEFAULT_LIMIT = 10;
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LOG_CHUNK_SIZE = 2000;
const DEFAULT_SOLANA_SIGNATURE_LIMIT = 100;


const DEFAULT_RPC_URLS = {
  ethereum: "https://cloudflare-eth.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  optimism: "https://mainnet.optimism.io",
  base: "https://mainnet.base.org",
  polygon: "https://polygon-rpc.com",
  bsc: "https://bsc-dataseed.binance.org",
  solana: "https://api.mainnet.solana.com",
};


const DEFAULT_BLOCK_TIMES = {
  ethereum: 12,
  arbitrum: 0.25,
  optimism: 2,
  base: 2,
  polygon: 2,
  bsc: 3,
};


const DEFAULT_ASSET_REGISTRY = {
  BTC: [
    {
      chain: "ethereum",
      contract: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      symbol: "WBTC",
      priceSymbol: "BTC",
      decimals: 8,
    },
  ],
  ETH: [
    {
      chain: "ethereum",
      contract: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      priceSymbol: "ETH",
      decimals: 18,
    },
  ],
  USDT: [
    {
      chain: "ethereum",
      contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      priceSymbol: "USDT",
      decimals: 6,
    },
  ],
  USDC: [
    {
      chain: "ethereum",
      contract: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      priceSymbol: "USDC",
      decimals: 6,
    },
  ],
  DAI: [
    {
      chain: "ethereum",
      contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      symbol: "DAI",
      priceSymbol: "DAI",
      decimals: 18,
    },
  ],
  LINK: [
    {
      chain: "ethereum",
      contract: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      symbol: "LINK",
      priceSymbol: "LINK",
      decimals: 18,
    },
  ],
  UNI: [
    {
      chain: "ethereum",
      contract: "0x1f9840a85d5aF5bf1D1762F925BDaddc4201F984",
      symbol: "UNI",
      priceSymbol: "UNI",
      decimals: 18,
    },
  ],
  AAVE: [
    {
      chain: "ethereum",
      contract: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
      symbol: "AAVE",
      priceSymbol: "AAVE",
      decimals: 18,
    },
  ],
  ARB: [
    {
      chain: "ethereum",
      contract: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1",
      symbol: "ARB",
      priceSymbol: "ARB",
      decimals: 18,
    },
  ],
  MATIC: [
    {
      chain: "ethereum",
      contract: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfebb0",
      symbol: "MATIC",
      priceSymbol: "MATIC",
      decimals: 18,
    },
  ],
  PEPE: [
    {
      chain: "ethereum",
      contract: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
      symbol: "PEPE",
      priceSymbol: "PEPE",
      decimals: 18,
    },
  ],
  SHIB: [
    {
      chain: "ethereum",
      contract: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",
      symbol: "SHIB",
      priceSymbol: "SHIB",
      decimals: 18,
    },
  ],
};


const publicCache = new Map();
const priceCache = new Map();


function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .replace(/^\$/, "")
    .replace(/\s+/g, "")
    .toUpperCase();
}


function normalizeChain(chain) {
  const value = String(chain || "").trim().toLowerCase();
  const aliases = {
    eth: "ethereum",
    mainnet: "ethereum",
    arb: "arbitrum",
    op: "optimism",
    matic: "polygon",
    binance: "bsc",
    "bnb smart chain": "bsc",
    sol: "solana",
  };


  return aliases[value] || value;
}


function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;


  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }


  const parsed = Number.parseFloat(
    String(value)
      .replace(/,/g, "")
      .replace(/[$%]/g, "")
      .replace(/−/g, "-")
      .trim()
  );


  return Number.isFinite(parsed) ? parsed : null;
}


function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;


  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Invalid JSON in " + name + "; using defaults.");
    return fallback;
  }
}


function getRpcUrls() {
  const configured = parseJsonEnv("ONCHAIN_RPC_URLS", {});
  return {
    ...DEFAULT_RPC_URLS,
    ...(configured && typeof configured === "object" ? configured : {}),
  };
}


function getAssetRegistry() {
  const configured = parseJsonEnv("ONCHAIN_ASSET_REGISTRY", {});
  return {
    ...DEFAULT_ASSET_REGISTRY,
    ...(configured && typeof configured === "object" ? configured : {}),
  };
}


function normalizeAssetConfigs(symbol) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const registry = getAssetRegistry();
  const raw =
    registry[normalizedSymbol] ||
    registry[normalizedSymbol.toLowerCase()] ||
    null;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];


  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;


      const chain = normalizeChain(entry.chain || entry.network);
      const address = String(
        entry.contract || entry.mint || entry.address || ""
      ).trim();


      if (!chain || !address) return null;


      return {
        chain,
        address,
        symbol: normalizeSymbol(entry.symbol || normalizedSymbol),
        priceSymbol: normalizeSymbol(
          entry.priceSymbol || entry.price_symbol || entry.symbol || normalizedSymbol
        ),
        decimals: Number.isInteger(Number(entry.decimals))
          ? Number(entry.decimals)
          : null,
      };
    })
    .filter(Boolean);
}


function normalizeAddress(address) {
  return String(address || "").trim().toLowerCase();
}


function getExchangeRegistry() {
  const raw = parseJsonEnv("ONCHAIN_EXCHANGE_ADDRESSES", {});
  const registry = {};


  const add = (chain, address, label) => {
    const normalizedChain = normalizeChain(chain);
    const normalizedAddress = normalizeAddress(address);
    if (!normalizedChain || !normalizedAddress) return;


    if (!registry[normalizedChain]) registry[normalizedChain] = new Map();
    registry[normalizedChain].set(
      normalizedAddress,
      String(label || "Known Exchange")
    );
  };


  if (Array.isArray(raw)) {
    for (const entry of raw) {
      add(entry?.chain, entry?.address, entry?.label);
    }
  } else if (raw && typeof raw === "object") {
    for (const [chain, entries] of Object.entries(raw)) {
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (typeof entry === "string") add(chain, entry, "Known Exchange");
          else add(chain, entry?.address, entry?.label);
        }
      } else if (entries && typeof entries === "object") {
        for (const [address, label] of Object.entries(entries)) {
          if (label && typeof label === "object") {
            add(chain, address, label.label || label.name);
          } else {
            add(chain, address, label);
          }
        }
      }
    }
  }


  return registry;
}


function exchangeLabel(exchangeRegistry, chain, address) {
  return exchangeRegistry[normalizeChain(chain)]?.get(normalizeAddress(address)) || null;
}


function hexToNumber(value) {
  const parsed = Number.parseInt(String(value || "0x0"), 16);
  return Number.isFinite(parsed) ? parsed : 0;
}


function topicAddress(topic) {
  const value = String(topic || "");
  return value.length >= 40 ? "0x" + value.slice(-40).toLowerCase() : null;
}


function safeAmountFromRaw(raw, decimals) {
  try {
    const integer = BigInt(raw || "0x0");
    const divisor = 10 ** Math.max(0, Number(decimals || 0));
    const amount = Number(integer) / divisor;
    return Number.isFinite(amount) ? amount : null;
  } catch {
    return null;
  }
}


function makeMove({
  hash,
  timestamp,
  asset,
  amount,
  valueUsd,
  from,
  fromLabel,
  fromIsExchange,
  to,
  toLabel,
  toIsExchange,
  chain,
}) {
  return {
    hash: hash || null,
    timestamp,
    time: new Date(timestamp).toISOString(),
    asset: normalizeSymbol(asset),
    amount,
    valueUsd,
    from: from || null,
    fromLabel: fromLabel || "Unknown Wallet",
    fromIsExchange: Boolean(fromIsExchange),
    to: to || null,
    toLabel: toLabel || "Unknown Wallet",
    toIsExchange: Boolean(toIsExchange),
    transferType:
      fromIsExchange && toIsExchange
        ? "EXCHANGE_TO_EXCHANGE"
        : toIsExchange
        ? "TO_EXCHANGE"
        : fromIsExchange
        ? "FROM_EXCHANGE"
        : "WALLET_TO_WALLET",
    chain: normalizeChain(chain),
    source: "PUBLIC_RPC",
  };
}


async function rpcCall(url, method, params) {
  const response = await axios.post(
    url,
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    },
    { timeout: 15000 }
  );


  const body = response?.data;
  if (body?.error) {
    throw new Error(
      method +
        ": " +
        (body.error.message || body.error.code || "RPC error")
    );
  }


  if (body?.result === undefined) {
    throw new Error(method + ": RPC response did not include result.");
  }


  return body.result;
}


async function getPriceUsd(symbol, config) {
  const priceSymbol = normalizeSymbol(
    config.priceSymbol || config.symbol || symbol
  );
  const stablecoins = new Set(["USDT", "USDC", "DAI", "USDS", "FDUSD"]);
  if (stablecoins.has(priceSymbol)) return 1;


  const cached = priceCache.get(priceSymbol);
  if (cached && Date.now() - cached.timestamp < 60 * 1000) {
    return cached.value;
  }


  const endpoint =
    process.env.ONCHAIN_PRICE_ENDPOINT ||
    "https://api.binance.com/api/v3/ticker/price";
  const market =
    priceSymbol.endsWith("USDT") ? priceSymbol : priceSymbol + "USDT";


  try {
    const response = await axios.get(endpoint, {
      timeout: 10000,
      params: { symbol: market },
    });
    const value = toFiniteNumber(response?.data?.price);


    if (value === null || value <= 0) return null;


    priceCache.set(priceSymbol, {
      timestamp: Date.now(),
      value,
    });


    return value;
  } catch (error) {
    console.warn(
      "Public price unavailable for " + priceSymbol + ": " + error.message
    );
    return null;
  }
}


async function collectEvmTransfers(config, requestedSymbol, options, exchangeRegistry) {
  const rpcUrls = getRpcUrls();
  const rpcUrl = rpcUrls[config.chain];


  if (!rpcUrl) {
    throw new Error("No public RPC configured for " + config.chain + ".");
  }


  const latest = hexToNumber(await rpcCall(rpcUrl, "eth_blockNumber", []));
  const blockTime = DEFAULT_BLOCK_TIMES[config.chain] || 12;
  const lookbackHours = Number(
    options.lookbackHours || DEFAULT_LOOKBACK_HOURS
  );
  const lookbackBlocks = Math.ceil(
    (Math.max(1, lookbackHours) * 60 * 60) / blockTime
  );
  const fromBlock = Math.max(0, latest - lookbackBlocks - 2);
  const chunkSize = Math.max(
    100,
    Math.min(5000, Number(options.logChunkSize || DEFAULT_LOG_CHUNK_SIZE))
  );
  const minValueUsd = Number(
    options.minValueUsd || DEFAULT_MIN_VALUE_USD
  );
  const price = await getPriceUsd(requestedSymbol, config);
  const moves = [];


  if (price === null) {
    return {
      moves,
      warnings: [
        "No public USD price was available for " +
          normalizeSymbol(config.priceSymbol || config.symbol || requestedSymbol) +
          ".",
      ],
      unpricedTransfers: 1,
    };
  }


  for (
    let start = fromBlock;
    start <= latest;
    start += chunkSize
  ) {
    const end = Math.min(latest, start + chunkSize - 1);
    const logs = await rpcCall(rpcUrl, "eth_getLogs", [
      {
        address: config.address,
        fromBlock: "0x" + start.toString(16),
        toBlock: "0x" + end.toString(16),
        topics: [TRANSFER_TOPIC],
      },
    ]);


    for (const log of Array.isArray(logs) ? logs : []) {
      if (!Array.isArray(log.topics) || log.topics.length < 3) continue;


      const from = topicAddress(log.topics[1]);
      const to = topicAddress(log.topics[2]);
      const amount = safeAmountFromRaw(log.data, config.decimals);


      if (!from || !to || amount === null) continue;


      const valueUsd = amount * price;
      if (!Number.isFinite(valueUsd) || valueUsd < minValueUsd) continue;


      const fromLabel = exchangeLabel(exchangeRegistry, config.chain, from);
      const toLabel = exchangeLabel(exchangeRegistry, config.chain, to);
      const blockNumber = hexToNumber(log.blockNumber);
      const timestamp =
        Date.now() -
        Math.max(0, latest - blockNumber) * blockTime * 1000;


      moves.push(
        makeMove({
          hash: log.transactionHash,
          timestamp,
          asset: requestedSymbol,
          amount,
          valueUsd,
          from,
          fromLabel: fromLabel || "Unknown Wallet",
          fromIsExchange: Boolean(fromLabel),
          to,
          toLabel: toLabel || "Unknown Wallet",
          toIsExchange: Boolean(toLabel),
          chain: config.chain,
        })
      );
    }
  }


  return { moves, warnings: [], unpricedTransfers: 0 };
}


function solanaAccountKey(accountKeys, index) {
  const account = accountKeys?.[index];
  return typeof account === "string" ? account : account?.pubkey || null;
}


function tokenBalanceAmount(entry) {
  const tokenAmount = entry?.uiTokenAmount;
  if (!tokenAmount) return null;


  const raw = toFiniteNumber(tokenAmount.amount);
  const decimals = Number(tokenAmount.decimals || 0);
  if (raw === null) return null;


  return raw / 10 ** decimals;
}


async function collectSolanaTransfers(config, requestedSymbol, options, exchangeRegistry) {
  const rpcUrls = getRpcUrls();
  const rpcUrl = rpcUrls.solana;


  if (!rpcUrl) throw new Error("No public Solana RPC configured.");


  const solanaExchanges = exchangeRegistry.solana || new Map();
  if (!solanaExchanges.size) {
    return {
      moves: [],
      warnings: [
        "Solana exchange addresses are not configured in ONCHAIN_EXCHANGE_ADDRESSES.",
      ],
      unpricedTransfers: 0,
    };
  }


  const price = await getPriceUsd(requestedSymbol, config);
  if (price === null) {
    return {
      moves: [],
      warnings: [
        "No public USD price was available for " +
          normalizeSymbol(config.priceSymbol || config.symbol || requestedSymbol) +
          ".",
      ],
      unpricedTransfers: 1,
    };
  }


  const lookbackHours = Number(
    options.lookbackHours || DEFAULT_LOOKBACK_HOURS
  );
  const cutoff = Date.now() - Math.max(1, lookbackHours) * 60 * 60 * 1000;
  const signatureLimit = Math.max(
    10,
    Math.min(
      1000,
      Number(options.solanaSignatureLimit || DEFAULT_SOLANA_SIGNATURE_LIMIT)
    )
  );
  const moves = [];
  const seen = new Set();


  for (const [exchangeAddress, exchangeName] of [
    ...solanaExchanges.entries(),
  ].slice(0, 20)) {
    const tokenAccounts = new Set([exchangeAddress]);


    try {
      const accountResult = await rpcCall(
        rpcUrl,
        "getTokenAccountsByOwner",
        [
          exchangeAddress,
          { mint: config.address },
          { encoding: "jsonParsed" },
        ]
      );


      for (const account of accountResult?.value || []) {
        if (account?.pubkey) tokenAccounts.add(account.pubkey.toLowerCase());
      }
    } catch (error) {
      console.warn(
        "Solana token accounts unavailable for " +
          exchangeName +
          ": " +
          error.message
      );
    }


    for (const tokenAccount of tokenAccounts) {
      let signatures = [];


      try {
        signatures = await rpcCall(
          rpcUrl,
          "getSignaturesForAddress",
          [tokenAccount, { limit: signatureLimit }]
        );
      } catch (error) {
        console.warn(
          "Solana signatures unavailable for " +
            exchangeName +
            ": " +
            error.message
        );
        continue;
      }


      for (const signatureInfo of signatures || []) {
        const timestamp = Number(signatureInfo?.blockTime || 0) * 1000;
        if (!timestamp || timestamp < cutoff) continue;


        let transaction;
        try {
          transaction = await rpcCall(
            rpcUrl,
            "getTransaction",
            [
              signatureInfo.signature,
              { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
            ]
          );
        } catch (error) {
          continue;
        }


        const meta = transaction?.meta;
        if (!meta) continue;


        const accountKeys = transaction?.transaction?.message?.accountKeys || [];
        const pre = meta.preTokenBalances || [];
        const post = meta.postTokenBalances || [];
        const balances = new Map();


        for (const entry of [...pre, ...post]) {
          if (normalizeSymbol(entry?.mint) !== normalizeSymbol(config.address)) {
            continue;
          }


          const key =
            String(entry.accountIndex) +
            ":" +
            String(entry.mint || "").toLowerCase();
          const current = balances.get(key) || {
            accountIndex: entry.accountIndex,
            owner: entry.owner || null,
            pre: 0,
            post: 0,
            decimals: Number(entry.uiTokenAmount?.decimals || config.decimals || 0),
          };


          if (pre.includes(entry)) current.pre = tokenBalanceAmount(entry) || 0;
          if (post.includes(entry)) current.post = tokenBalanceAmount(entry) || 0;
          current.owner =
            current.owner ||
            entry.owner ||
            solanaAccountKey(accountKeys, entry.accountIndex);
          balances.set(key, current);
        }


        for (const balance of balances.values()) {
          const accountKey = solanaAccountKey(accountKeys, balance.accountIndex);
          const owner = normalizeAddress(balance.owner);
          const account = normalizeAddress(accountKey);
          const isExchange =
            solanaExchanges.has(owner) || solanaExchanges.has(account);
          if (!isExchange) continue;


          const delta = balance.post - balance.pre;
          if (!delta) continue;


          const amount = Math.abs(delta);
          const valueUsd = amount * price;
          if (!Number.isFinite(valueUsd) || valueUsd < minValueUsd) continue;


          const direction = delta > 0 ? "to" : "from";
          const dedupeKey =
            signatureInfo.signature + ":" + balance.accountIndex + ":" + direction;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);


          const exchangeLabel =
            solanaExchanges.get(owner) ||
            solanaExchanges.get(account) ||
            exchangeName;


          moves.push(
            makeMove({
              hash: signatureInfo.signature,
              timestamp,
              asset: requestedSymbol,
              amount,
              valueUsd,
              from: delta > 0 ? null : accountKey,
              fromLabel: delta > 0 ? "Unknown Wallet" : exchangeLabel,
              fromIsExchange: delta < 0,
              to: delta > 0 ? accountKey : null,
              toLabel: delta > 0 ? exchangeLabel : "Unknown Wallet",
              toIsExchange: delta > 0,
              chain: "solana",
            })
          );
        }
      }
    }
  }


  return { moves, warnings: [], unpricedTransfers: 0 };
}


function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0";
  if (number >= 1000000000) return "$" + (number / 1000000000).toFixed(1) + "B";
  if (number >= 1000000) return "$" + (number / 1000000).toFixed(1) + "M";
  if (number >= 1000) return "$" + (number / 1000).toFixed(1) + "K";
  return "$" + number.toFixed(0);
}


function normalizeWhaleTransactions(transactions, symbol, options = {}) {
  const lookbackHours = Number(options.lookbackHours || DEFAULT_LOOKBACK_HOURS);
  const minValueUsd = Number(options.minValueUsd || DEFAULT_MIN_VALUE_USD);
  const cutoff = Date.now() - Math.max(1, lookbackHours) * 60 * 60 * 1000;


  return (Array.isArray(transactions) ? transactions : [])
    .filter(
      (transaction) =>
        transaction &&
        Number(transaction.timestamp) >= cutoff &&
        Number(transaction.valueUsd) >= minValueUsd
    )
    .map((transaction) => ({
      ...transaction,
      asset: normalizeSymbol(transaction.asset || symbol),
      valueUsd: Number(transaction.valueUsd),
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}


function summarizeWhaleMoves(
  moves,
  symbol = "ASSET",
  lookbackHours = DEFAULT_LOOKBACK_HOURS
) {
  const recentMoves = Array.isArray(moves) ? moves : [];
  const toExchanges = recentMoves
    .filter((move) => move.toIsExchange)
    .reduce((sum, move) => sum + Number(move.valueUsd || 0), 0);
  const fromExchanges = recentMoves
    .filter((move) => move.fromIsExchange)
    .reduce((sum, move) => sum + Number(move.valueUsd || 0), 0);
  const total = recentMoves.reduce(
    (sum, move) => sum + Number(move.valueUsd || 0),
    0
  );
  const windowLabel = String(lookbackHours) + "h";


  if (!recentMoves.length) {
    return (
      "No " +
      formatUsd(DEFAULT_MIN_VALUE_USD) +
      "+ public on-chain transfers detected for $" +
      symbol +
      " in the last " +
      windowLabel +
      "."
    );
  }


  if (toExchanges > fromExchanges && toExchanges > 0) {
    return (
      "🐋 " +
      formatUsd(toExchanges) +
      " $" +
      symbol +
      " transferred to labeled exchanges in the last " +
      windowLabel +
      " — potential sell-side pressure."
    );
  }


  if (fromExchanges > toExchanges && fromExchanges > 0) {
    return (
      "🐋 " +
      formatUsd(fromExchanges) +
      " $" +
      symbol +
      " transferred from labeled exchanges in the last " +
      windowLabel +
      " — potential accumulation."
    );
  }


  return (
    "🐋 " +
    formatUsd(total) +
    " $" +
    symbol +
    " moved on-chain in the last " +
    windowLabel +
    " — exchange attribution is mixed or not configured."
  );
}


function buildActivity(
  symbol,
  moves,
  options,
  warnings,
  unpricedTransfers,
  assets
) {
  const limitedMoves = moves
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, Math.max(1, Number(options.limit || DEFAULT_LIMIT)));
  const toExchanges = limitedMoves
    .filter((move) => move.toIsExchange)
    .reduce((sum, move) => sum + Number(move.valueUsd || 0), 0);
  const fromExchanges = limitedMoves
    .filter((move) => move.fromIsExchange)
    .reduce((sum, move) => sum + Number(move.valueUsd || 0), 0);
  const largest = limitedMoves.length
    ? limitedMoves.reduce((best, move) =>
        move.valueUsd > best.valueUsd ? move : best
      )
    : null;


  return {
    status: limitedMoves.length ? "available" : "insufficient_data",
    symbol,
    provider: "PUBLIC_RPC",
    lookbackHours: Number(options.lookbackHours || DEFAULT_LOOKBACK_HOURS),
    minValueUsd: Number(options.minValueUsd || DEFAULT_MIN_VALUE_USD),
    transactions: limitedMoves,
    recentMoves: limitedMoves,
    volumeToExchanges: toExchanges,
    volumeFromExchanges: fromExchanges,
    largestMove: largest,
    largestToExchange:
      limitedMoves
        .filter((move) => move.toIsExchange)
        .sort((a, b) => b.valueUsd - a.valueUsd)[0] || null,
    largestFromExchange:
      limitedMoves
        .filter((move) => move.fromIsExchange)
        .sort((a, b) => b.valueUsd - a.valueUsd)[0] || null,
    summary: summarizeWhaleMoves(
      limitedMoves,
      symbol,
      Number(options.lookbackHours || DEFAULT_LOOKBACK_HOURS)
    ),
    assets,
    exchangeCoverage: warnings.some((warning) =>
      /ONCHAIN_EXCHANGE_ADDRESSES|exchange addresses/i.test(warning)
    )
      ? "unavailable"
      : "configured",
    warnings: [...new Set(warnings)],
    unpricedTransfers,
  };
}


function unavailable(symbol, reason) {
  return {
    status: "unavailable",
    symbol,
    provider: "PUBLIC_RPC",
    lookbackHours: DEFAULT_LOOKBACK_HOURS,
    minValueUsd: DEFAULT_MIN_VALUE_USD,
    transactions: [],
    recentMoves: [],
    volumeToExchanges: 0,
    volumeFromExchanges: 0,
    largestMove: null,
    largestToExchange: null,
    largestFromExchange: null,
    summary: "Public on-chain data unavailable: " + String(reason),
    warnings: [String(reason)],
    error: String(reason),
  };
}


async function collectPublicWhaleActivity(symbol, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const assets = normalizeAssetConfigs(normalizedSymbol);


  if (!normalizedSymbol) {
    return unavailable("UNKNOWN", "No symbol was provided.");
  }


  if (!assets.length) {
    return unavailable(
      normalizedSymbol,
      "No ONCHAIN_ASSET_REGISTRY entry exists for $" + normalizedSymbol + "."
    );
  }


  const exchangeRegistry = getExchangeRegistry();
  const exchangeRegistryConfigured = Object.values(exchangeRegistry).some(
    (entries) => entries instanceof Map && entries.size > 0
  );
  const moves = [];
  const warnings = [];
  if (!exchangeRegistryConfigured) {
    warnings.push(
      "ONCHAIN_EXCHANGE_ADDRESSES is not configured; exchange-flow attribution is unavailable."
    );
  }
  let unpricedTransfers = 0;


  for (const asset of assets) {
    try {
      const result =
        asset.chain === "solana"
          ? await collectSolanaTransfers(
              asset,
              normalizedSymbol,
              options,
              exchangeRegistry
            )
          : await collectEvmTransfers(
              asset,
              normalizedSymbol,
              options,
              exchangeRegistry
            );


      moves.push(...result.moves);
      warnings.push(...(result.warnings || []));
      unpricedTransfers += Number(result.unpricedTransfers || 0);
    } catch (error) {
      warnings.push(asset.chain + ": " + error.message);
    }
  }


  if (!moves.length && warnings.length && warnings.every((warning) =>
    /No .*entry|No public RPC|RPC|unavailable|not configured|price/i.test(warning)
  )) {
    return {
      ...unavailable(normalizedSymbol, warnings.join(" ")),
      assets,
      warnings: [...new Set(warnings)],
      unpricedTransfers,
    };
  }


  return buildActivity(
    normalizedSymbol,
    moves,
    options,
    warnings,
    unpricedTransfers,
    assets
  );
}


async function checkWhaleActivity(symbol, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const lookbackHours = Number(
    options.lookbackHours || DEFAULT_LOOKBACK_HOURS
  );
  const minValueUsd = Number(
    options.minValueUsd || DEFAULT_MIN_VALUE_USD
  );
  const limit = Math.max(
    1,
    Math.min(100, Number(options.limit || DEFAULT_LIMIT))
  );
  const cacheKey = [
    normalizedSymbol,
    lookbackHours,
    minValueUsd,
    limit,
    process.env.ONCHAIN_ASSET_REGISTRY || "defaults",
    process.env.ONCHAIN_EXCHANGE_ADDRESSES || "no-exchange-registry",
  ].join(":");
  const cached = publicCache.get(cacheKey);


  if (
    cached &&
    Date.now() - cached.timestamp < CACHE_TTL_MS &&
    cached.data.status !== "unavailable"
  ) {
    return cached.data;
  }


  publicCache.delete(cacheKey);


  try {
    const activity = await collectPublicWhaleActivity(normalizedSymbol, {
      ...options,
      lookbackHours,
      minValueUsd,
      limit,
    });


    if (activity.status !== "unavailable" && !(activity.warnings || []).length) {
      publicCache.set(cacheKey, {
        timestamp: Date.now(),
        data: activity,
      });
    }


    return activity;
  } catch (error) {
    console.warn(
      "Public on-chain whale scan unavailable for $" +
        normalizedSymbol +
        ": " +
        error.message
    );
    return unavailable(normalizedSymbol, error.message);
  }
}


function clearWhaleCache() {
  publicCache.clear();
  priceCache.clear();
}


module.exports = {
  checkWhaleActivity,
  collectPublicWhaleActivity,
  normalizeAssetConfigs,
  normalizeWhaleTransactions,
  summarizeWhaleMoves,
  formatUsd,
  clearWhaleCache,
};
