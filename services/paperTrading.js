const { openDatabase } = require("./database");
const { resolveAccountIdForChat } = require("./accountData");

const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS paper_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT,
    chat_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    venue TEXT NOT NULL DEFAULT 'Binance',
    direction TEXT NOT NULL CHECK(direction IN ('LONG', 'SHORT')),
    margin REAL NOT NULL,
    leverage REAL NOT NULL,
    notional REAL NOT NULL,
    quantity REAL NOT NULL,
    entry_price REAL NOT NULL,
    mark_price REAL NOT NULL,
    stop_loss REAL,
    take_profit REAL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    realized_pnl REAL,
    exit_price REAL,
    exit_reason TEXT,
    opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_paper_positions_chat_status
    ON paper_positions(chat_id, status);
`);

try { db.prepare("ALTER TABLE paper_positions ADD COLUMN account_id TEXT").run(); } catch {}
db.prepare("CREATE INDEX IF NOT EXISTS idx_paper_positions_account_status ON paper_positions(account_id, status)").run();

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(value) {
  const symbol = String(value || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return symbol.endsWith("USDT") ? symbol : symbol + "USDT";
}

function displaySymbol(symbol) {
  return String(symbol || "").replace(/USDT$/, "") + "USDT";
}

function normalizeVenue(value) {
  const venue = String(value || "Binance").trim().toLowerCase();
  if (venue.includes("bybit")) return "Bybit";
  if (venue.includes("okx")) return "OKX";
  if (venue.includes("hyper")) return "Hyperliquid";
  return "Binance";
}

function parsePaperCommand(text) {
  const input = String(text || "").trim();
  const command = input.replace(/^\/paper(?:@\w+)?\s*/i, "").trim();
  if (!command || /^(help|usage)$/i.test(command)) return { action: "help" };
  if (/^(positions?|open)$/i.test(command)) return { action: "positions" };
  if (/^(stats?|performance)$/i.test(command)) return { action: "stats" };
  const close = command.match(/^close(?:\s+\$?([a-z0-9_-]+))?$/i);
  if (close) return { action: "close", symbol: close[1] ? normalizeSymbol(close[1]) : null };

  const match = command.match(
    /^(long|short)\s+\$?([a-z0-9_-]+)\s+([\d.]+)\s+(?:(?:x|lev|leverage)\s*)?([\d.]+)(.*)$/i
  );
  if (!match) return null;
  const tail = match[5] || "";
  const option = (namePattern) => {
    const found = tail.match(new RegExp(`(?:^|\\s)(?:${namePattern})\\s*=\\s*([\\d.]+)`, "i"));
    return found ? number(found[1]) : null;
  };
  const venueMatch = tail.match(/(?:^|\s)(?:venue|exchange)\s*=\s*([a-z]+)/i);
  return {
    action: "open",
    direction: match[1].toUpperCase(),
    symbol: normalizeSymbol(match[2]),
    margin: number(match[3]),
    leverage: number(match[4]),
    stopLoss: option("sl|stop(?:_loss)?"),
    takeProfit: option("tp|take(?:_profit)?"),
    venue: normalizeVenue(venueMatch?.[1] || "Binance"),
  };
}

function calculatePnl(position, markPrice) {
  const delta = position.direction === "LONG"
    ? markPrice - position.entry_price
    : position.entry_price - markPrice;
  const pnl = delta * position.quantity;
  return { pnl, pnlPercent: position.margin ? (pnl / position.margin) * 100 : 0 };
}

function priceEndpoint(symbol, venue) {
  if (venue === "Bybit") return `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`;
  if (venue === "OKX") return `https://www.okx.com/api/v5/market/ticker?instId=${symbol.replace("USDT", "-USDT-SWAP")}`;
  return `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
}

async function fetchMarkPrice(symbol, venue = "Binance", fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("Price provider is unavailable.");
  const requestedVenue = normalizeVenue(venue);
  const candidates = [requestedVenue, "Bybit", "OKX", "Binance"].filter((item, index, list) => list.indexOf(item) === index);
  const failures = [];
  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(priceEndpoint(symbol, candidate), {
        signal: AbortSignal.timeout(8000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(candidate + " price request failed (" + response.status + ").");
      const body = await response.json();
      const raw = candidate === "Bybit"
        ? body?.result?.list?.[0]?.lastPrice
        : candidate === "OKX"
          ? body?.data?.[0]?.last
          : body?.price;
      const price = number(raw);
      if (!price || price <= 0) throw new Error(candidate + " returned no usable price for " + symbol + ".");
      return price;
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error("All public price providers failed: " + failures.join(" | "));
}
function validateOrder(order) {
  if (!order || !["LONG", "SHORT"].includes(order.direction)) throw new Error("Direction must be LONG or SHORT.");
  if (!order.symbol || !order.symbol.endsWith("USDT")) throw new Error("Use a USDT perpetual symbol, for example BTCUSDT.");
  if (!Number.isFinite(order.margin) || order.margin < 10) throw new Error("Margin must be at least $10.");
  if (!Number.isFinite(order.leverage) || order.leverage < 1 || order.leverage > 50) throw new Error("Leverage must be between 1x and 50x.");
  if (order.stopLoss !== null && (!Number.isFinite(order.stopLoss) || order.stopLoss <= 0)) throw new Error("Stop-loss must be a positive price.");
  if (order.takeProfit !== null && (!Number.isFinite(order.takeProfit) || order.takeProfit <= 0)) throw new Error("Take-profit must be a positive price.");
  if (order.direction === "LONG" && order.stopLoss !== null && order.stopLoss >= order.takeProfit && order.takeProfit !== null) throw new Error("For a LONG, SL must be below TP.");
  if (order.direction === "SHORT" && order.stopLoss !== null && order.stopLoss <= order.takeProfit && order.takeProfit !== null) throw new Error("For a SHORT, SL must be above TP.");
}

async function openPosition(chatId, order, fetchImpl) {
  validateOrder(order);
  const accountId = resolveAccountIdForChat(chatId);
  db.prepare("UPDATE paper_positions SET account_id = ? WHERE chat_id = ? AND (account_id IS NULL OR account_id = '')").run(accountId, String(chatId));
  const existing = db.prepare("SELECT id FROM paper_positions WHERE account_id = ? AND symbol = ? AND status = 'OPEN'").get(accountId, order.symbol);
  if (existing) throw new Error(`You already have an open paper position on ${displaySymbol(order.symbol)}. Close it first.`);
  const entryPrice = await fetchMarkPrice(order.symbol, order.venue, fetchImpl);
  const notional = order.margin * order.leverage;
  const quantity = notional / entryPrice;
  const result = db.prepare(`
    INSERT INTO paper_positions
      (account_id, chat_id, symbol, venue, direction, margin, leverage, notional, quantity, entry_price, mark_price, stop_loss, take_profit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(accountId, String(chatId), order.symbol, order.venue, order.direction, order.margin, order.leverage, notional, quantity, entryPrice, entryPrice, order.stopLoss, order.takeProfit);
  return getPosition(result.lastInsertRowid);
}

function getPosition(id) {
  return db.prepare("SELECT * FROM paper_positions WHERE id = ?").get(Number(id));
}

function getOpenPositions(chatId) {
  const accountId = resolveAccountIdForChat(chatId);
  db.prepare("UPDATE paper_positions SET account_id = ? WHERE chat_id = ? AND (account_id IS NULL OR account_id = '')").run(accountId, String(chatId));
  return db.prepare("SELECT * FROM paper_positions WHERE account_id = ? AND status = 'OPEN' ORDER BY id DESC").all(accountId);
}

function closePosition(id, exitPrice, reason = "MANUAL") {
  const position = getPosition(id);
  if (!position || position.status !== "OPEN") return null;
  const mark = number(exitPrice) || position.mark_price;
  const { pnl } = calculatePnl(position, mark);
  db.prepare(`UPDATE paper_positions SET status = 'CLOSED', mark_price = ?, exit_price = ?, realized_pnl = ?, exit_reason = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(mark, mark, pnl, reason, position.id);
  return getPosition(position.id);
}

async function refreshPositions(chatId = null, { fetchImpl = globalThis.fetch } = {}) {
  const positions = chatId === null
    ? db.prepare("SELECT * FROM paper_positions WHERE status = 'OPEN'").all()
    : getOpenPositions(chatId);
  const updated = [];
  const closed = [];
  for (const position of positions) {
    try {
      const mark = await fetchMarkPrice(position.symbol, position.venue, fetchImpl);
      const hitStop = position.stop_loss !== null && (position.direction === "LONG" ? mark <= position.stop_loss : mark >= position.stop_loss);
      const hitTarget = position.take_profit !== null && (position.direction === "LONG" ? mark >= position.take_profit : mark <= position.take_profit);
      if (hitStop || hitTarget) {
        closed.push(closePosition(position.id, mark, hitStop ? "STOP_LOSS" : "TAKE_PROFIT"));
      } else {
        db.prepare("UPDATE paper_positions SET mark_price = ? WHERE id = ?").run(mark, position.id);
        updated.push(getPosition(position.id));
      }
    } catch (error) {
      updated.push({ ...position, priceError: error.message });
    }
  }
  return { updated, closed };
}

function formatMoney(value) {
  const amount = number(value);
  return amount === null ? "—" : `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPosition(position) {
  const { pnl, pnlPercent } = calculatePnl(position, position.mark_price);
  const icon = position.direction === "LONG" ? "📈" : "📉";
  return `${icon} PAPER ${position.direction} — ${displaySymbol(position.symbol)}\n\nEntry: ${formatMoney(position.entry_price)}\nMark: ${formatMoney(position.mark_price)}\nMargin: ${formatMoney(position.margin)}\nLeverage: ${position.leverage}x\nNotional: ${formatMoney(position.notional)}\n\nPnL: ${pnl >= 0 ? "+" : ""}${formatMoney(pnl)} (${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%)\nSL: ${formatMoney(position.stop_loss)}\nTP: ${formatMoney(position.take_profit)}\n\nStatus: ${position.status} · ${position.venue}`;
}

function formatClosed(position) {
  return `${position.direction === "LONG" ? "📈" : "📉"} PAPER ${position.direction} — ${displaySymbol(position.symbol)}\nClosed: ${formatMoney(position.exit_price)}\nPnL: ${position.realized_pnl >= 0 ? "+" : ""}${formatMoney(position.realized_pnl)}\nReason: ${position.exit_reason}`;
}

async function getStats(chatId, { fetchImpl = globalThis.fetch } = {}) {
  const accountId = resolveAccountIdForChat(chatId);
  const open = getOpenPositions(chatId);
  const refreshed = await refreshPositions(chatId, { fetchImpl });
  const closed = db.prepare("SELECT * FROM paper_positions WHERE account_id = ? AND status = 'CLOSED' ORDER BY id DESC LIMIT 100").all(accountId);
  const realized = closed.reduce((sum, row) => sum + Number(row.realized_pnl || 0), 0);
  const unrealized = refreshed.updated.reduce((sum, row) => sum + calculatePnl(row, row.mark_price).pnl, 0);
  const wins = closed.filter((row) => Number(row.realized_pnl) > 0).length;
  return { open: refreshed.updated, closed: refreshed.closed, realized, unrealized, wins, losses: closed.filter((row) => Number(row.realized_pnl) < 0).length, totalClosed: closed.length, openBeforeRefresh: open.length };
}

function startPaperTradingMonitor(onClosed) {
  const intervalMs = Math.max(10000, Number(process.env.PERPSIA_PAPER_REFRESH_MS || 30000));
  const timer = setInterval(async () => {
    try {
      const result = await refreshPositions();
      for (const position of result.closed) await onClosed?.(position);
    } catch (error) {
      console.error("Paper trading monitor failed:", error.message);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  closePosition,
  fetchMarkPrice,
  formatClosed,
  formatPosition,
  getOpenPositions,
  getStats,
  normalizeSymbol,
  openPosition,
  parsePaperCommand,
  refreshPositions,
  startPaperTradingMonitor,
};
