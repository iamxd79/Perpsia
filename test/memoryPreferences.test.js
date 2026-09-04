const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.PERPSIA_DB_PATH = path.join(
  os.tmpdir(),
  "perpsia-telegram-ui-" + process.pid + "-" + Date.now() + ".db"
);

const {
  addToWatchlist,
  getUserPreferences,
  getWatchlist,
  removeFromWatchlist,
  saveUserPreferences,
} = require("../services/memory");

test("persists watchlist additions and removals", () => {
  const chatId = "watchlist-test-" + process.pid;
  addToWatchlist(chatId, "$sol");
  addToWatchlist(chatId, "SOL");
  assert.deepEqual(getWatchlist(chatId).map(({ symbol }) => symbol), ["SOL"]);
  removeFromWatchlist(chatId, "sol");
  assert.deepEqual(getWatchlist(chatId), []);
});

test("persists Telegram settings callbacks using database field names", () => {
  const chatId = "settings-test-" + process.pid;
  saveUserPreferences(chatId, {
    preferred_exchange: "OKX",
    alert_frequency: "12h",
    signal_sensitivity: "conservative",
  });
  const saved = getUserPreferences(chatId);
  assert.equal(saved.preferred_exchange, "OKX");
  assert.equal(saved.alert_frequency, "12h");
  assert.equal(saved.signal_sensitivity, "conservative");
});
