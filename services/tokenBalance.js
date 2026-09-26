"use strict";

const { getUserWallets } = require("./wallets");
const { getAsset, validateAsset } = require("./assetRegistry");

const cache = new Map();
const MAX_CACHE = 500;
function evict() { while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); }
function hexQuantity(value) { const parsed = BigInt(value); return "0x" + parsed.toString(16); }
function encodeBalanceOf(address) { return "0x70a08231" + String(address).replace(/^0x/, "").toLowerCase().padStart(64, "0"); }
async function rpcBalance(asset, wallet, fetchImpl = globalThis.fetch) {
  if (!asset.contractAddress) return { status: "mock", raw: "0", formatted: "0", source: "mock" };
  if (typeof fetchImpl !== "function") throw new Error("Balance provider is unavailable.");
  const response = await fetchImpl(asset.chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: asset.contractAddress, data: encodeBalanceOf(wallet.normalizedAddress) }, "latest"] }) });
  if (!response.ok) throw new Error(`Token RPC failed (${response.status}).`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "Token RPC returned an error.");
  const raw = BigInt(body.result || "0x0");
  const formatted = Number(raw) / (10 ** asset.decimals);
  return { status: "live", raw: raw.toString(), formatted: String(formatted), source: "rpc" };
}
async function getWalletBalance(wallet, assetInput = "PERPSIA", options = {}) {
  const asset = validateAsset(typeof assetInput === "string" ? getAsset(assetInput) : assetInput);
  if (!wallet || wallet.chain?.namespace !== asset.namespace || String(wallet.chain?.id) !== String(asset.chainId)) return { status: "unavailable", reason: "wallet_chain_mismatch", asset: asset.symbol };
  const key = `${asset.symbol}:${wallet.normalizedAddress}:${asset.chainId}`;
  const now = Date.now(); const ttl = Math.max(1000, Number(process.env.PERPSIA_TOKEN_BALANCE_TTL_MS || 60000));
  const cached = cache.get(key); if (cached && cached.expiresAt > now) return { ...cached.value, cached: true };
  try {
    const value = await rpcBalance(asset, wallet, options.fetchImpl);
    const result = { ...value, asset: asset.symbol, chain: asset.chainId, address: wallet.address, cached: false };
    cache.set(key, { value: result, expiresAt: now + ttl }); evict(); return result;
  } catch (error) { return { status: "degraded", asset: asset.symbol, chain: asset.chainId, address: wallet.address, reason: error.message, source: "rpc" }; }
}
async function getAccountBalance(accountId, assetInput = "PERPSIA", options = {}) {
  const wallets = getUserWallets(accountId).filter((wallet) => wallet.ownershipStatus === "verified");
  const balances = await Promise.all(wallets.map((wallet) => getWalletBalance(wallet, assetInput, options)));
  return { asset: typeof assetInput === "string" ? assetInput.replace(/^\$/, "").toUpperCase() : assetInput.symbol, balances, total: balances.filter((item) => item.status === "live" || item.status === "mock").reduce((sum, item) => sum + Number(item.formatted || 0), 0) };
}
module.exports = { getAccountBalance, getWalletBalance, encodeBalanceOf, hexQuantity };
