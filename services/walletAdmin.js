"use strict";

const { listOnchainEvents } = require("./onchainStore");
const { getAlchemySyncHealth, syncAlchemyWatchlist } = require("./alchemySync");
const { refreshGmgnSmartMoney } = require("./providers/gmgn");
const { getWalletRefreshHealth, refreshWalletWatchlist } = require("./walletRefresh");
const registry = require("./walletRegistry");

function addWallet(input) {
  return registry.importManualWallet(input);
}

function disableWallet(walletId) {
  return registry.setWalletEnabled(walletId, false);
}

function enableWallet(walletId) {
  return registry.setWalletEnabled(walletId, true);
}

function relabelWallet(walletId, changes) {
  return registry.relabelWallet(walletId, changes);
}

function approveWallet(walletId, notes) {
  return registry.approveWallet(walletId, notes);
}

function importGmgnWallets(records, options) {
  return registry.importGmgnWallets(records, options);
}

function importVerifiedExchangeWallets(records) {
  return registry.importExchangeWallets(records);
}

function importKols(records) {
  return registry.importKols(records);
}

function importFunds(records) {
  return registry.importFunds(records);
}

function importGmgnSmartMoney(options) {
  return refreshGmgnSmartMoney(options);
}

function listWallets(filters) {
  return registry.listWallets(filters);
}

function inspectWalletHistory(walletId, options = {}) {
  const wallet = registry.getWallet(walletId);
  if (!wallet) return { wallet: null, events: [] };
  const events = listOnchainEvents({
    chain: wallet.chain,
    lookbackHours: options.lookbackHours || 24 * 30,
    limit: options.limit || 1000,
  }).filter((event) => [event.fromAddress, event.toAddress].map(registry.normalizeAddress).includes(wallet.address));
  return { wallet, events };
}

function inspectSyncStatus(filters) {
  return {
    health: getAlchemySyncHealth(),
    wallets: registry.listAlchemySync(filters),
    webhooks: registry.listAlchemyWebhooks(),
  };
}

function verifyPending() {
  return registry.listWallets({ verificationStatus: "pending" });
}

function listListingWatch(filters) {
  return registry.listListingWatchEvents(filters);
}

function triggerAlchemySync(options) {
  return syncAlchemyWatchlist(options);
}

function refreshWallets(options) {
  return refreshWalletWatchlist({ ...options, enabled: true });
}

module.exports = {
  addWallet,
  approveWallet,
  disableWallet,
  enableWallet,
  importGmgnWallets,
  importGmgnSmartMoney,
  importVerifiedExchangeWallets,
  importKols,
  importFunds,
  inspectSyncStatus,
  inspectWalletHistory,
  getWalletRefreshHealth,
  listListingWatch,
  listWallets,
  relabelWallet,
  triggerAlchemySync,
  refreshWallets,
  verifyPending,
};
