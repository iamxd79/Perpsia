const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.PERPSIA_DB_PATH = path.join(os.tmpdir(), "perpsia-account-data-" + process.pid + "-" + Date.now() + ".db");

const { getOrCreateTelegramAccount, getOrCreateIdentity } = require("../services/accountIdentity");
const { addAccountWatchlist, getAccountOverview, getAccountRisk, saveAccountPreferences, saveAccountRisk } = require("../services/accountData");
const { addToWatchlist, getRiskSettings, getUserPreferences, saveRiskSettings, saveUserPreferences } = require("../services/memory");
const { getPrimaryWallet, getUserWallets, linkWallet, resolveAccountByWallet, setPrimaryWallet, unlinkWallet } = require("../services/wallets");
const { openPosition, getOpenPositions } = require("../services/paperTrading");
const { createAccountAlert, listAccountAlerts, updateAccountAlert, deleteAccountAlert } = require("../services/accountAlerts");

test("Telegram state resolves through one account and remains visible to the web overview", () => {
  const identity = getOrCreateTelegramAccount("account-data-telegram");
  saveUserPreferences("account-data-telegram", { preferred_exchange: "Bybit" });
  saveRiskSettings("account-data-telegram", 10000, 1, 3);
  addToWatchlist("account-data-telegram", "BTC");
  const overview = getAccountOverview(identity.account_id);
  assert.equal(overview.preferences.preferred_exchange, "Bybit");
  assert.equal(overview.risk.max_leverage, 3);
  assert.deepEqual(overview.watchlist.map((item) => item.symbol), ["BTC"]);
  assert.equal(getUserPreferences("account-data-telegram").preferred_exchange, "Bybit");
  assert.equal(getRiskSettings("account-data-telegram").capital, 10000);
});

test("wallet ownership is unique, supports multiple wallets, and protects primary changes", () => {
  const account = getOrCreateIdentity("privy", "did:privy:wallet-owner");
  const first = linkWallet(account.account_id, { address: "0x0000000000000000000000000000000000000001", chain: { namespace: "eip155", id: "1" }, provider: "privy" });
  const second = linkWallet(account.account_id, { address: "0x0000000000000000000000000000000000000002", chain: { namespace: "eip155", id: "1" }, provider: "metamask" });
  assert.equal(first.isPrimary, true);
  assert.equal(second.isPrimary, false);
  assert.equal(getUserWallets(account.account_id).length, 2);
  assert.equal(resolveAccountByWallet({ address: "0x0000000000000000000000000000000000000001", chain: { namespace: "eip155", id: "1" } }).accountId, account.account_id);
  assert.throws(() => linkWallet(getOrCreateIdentity("privy", "did:privy:other").account_id, { address: "0x0000000000000000000000000000000000000001", chain: { namespace: "eip155", id: "1" } }), /already linked/);
  setPrimaryWallet(account.account_id, second.walletId);
  assert.equal(getPrimaryWallet(account.account_id).walletId, second.walletId);
  unlinkWallet(account.account_id, first.walletId);
  assert.equal(getUserWallets(account.account_id).length, 1);
});

test("paper positions and alerts are isolated by internal account ownership", async () => {
  const first = getOrCreateTelegramAccount("account-owner-one");
  const second = getOrCreateTelegramAccount("account-owner-two");
  await openPosition("account-owner-one", { direction: "LONG", symbol: "BTCUSDT", margin: 100, leverage: 2, stopLoss: null, takeProfit: null, venue: "Binance" }, async () => ({ ok: true, json: async () => ({ price: "50000" }) }));
  assert.equal(getOpenPositions("account-owner-one").length, 1);
  assert.equal(getOpenPositions("account-owner-two").length, 0);
  const alert = createAccountAlert(first.account_id, { symbol: "BTCUSDT", alertType: "price", condition: { above: 60000 } });
  assert.equal(listAccountAlerts(first.account_id).length, 1);
  assert.equal(listAccountAlerts(second.account_id).length, 0);
  assert.equal(updateAccountAlert(second.account_id, alert.alertId, { status: "paused" }), null);
  assert.equal(deleteAccountAlert(first.account_id, alert.alertId), true);
});
