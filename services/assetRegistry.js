"use strict";

const { getChain } = require("./chainRegistry");

const status = String(process.env.PERPSIA_ASSET_STATUS || "mock").toLowerCase();
const mockAddress = String(process.env.PERPSIA_MOCK_TOKEN_ADDRESS || "").trim().toLowerCase() || null;
const ASSETS = [{
  symbol: "PERPSIA", name: "PerpsIA", namespace: "eip155", chainId: "46630",
  contractAddress: mockAddress, decimals: 18, status: ["mock", "test", "planned", "active", "deprecated"].includes(status) ? status : "mock",
  metadata: { purpose: "PerpsIA access and staking utility", network: "Robinhood Chain Testnet", disclaimer: "No mainnet token contract is deployed or verified." },
}];

function getAsset(symbol = "PERPSIA") {
  const asset = ASSETS.find((item) => item.symbol === String(symbol).replace(/^\$/, "").toUpperCase());
  if (!asset) return null;
  return { ...asset, chain: getChain(asset.namespace, asset.chainId), metadata: { ...asset.metadata } };
}
function listAssets() { return ASSETS.map((asset) => getAsset(asset.symbol)); }
function validateAsset(asset) {
  if (!asset) throw new Error("Unknown PerpsIA asset.");
  if (asset.status === "active" && !/^0x[a-f0-9]{40}$/.test(asset.contractAddress || "")) throw new Error("An active asset requires a verified contract address.");
  if (asset.status !== "mock" && !asset.chain) throw new Error("Asset chain is not configured.");
  return asset;
}

module.exports = { getAsset, listAssets, validateAsset };
