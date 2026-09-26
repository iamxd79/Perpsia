"use strict";

const { getAsset } = require("./assetRegistry");
const { getChain } = require("./chainRegistry");

let last = { status: "unknown", checkedAt: null, error: null, chainId: null };
let checking;
async function checkRpc(fetchImpl = globalThis.fetch) {
  const chain = getChain("eip155", process.env.PERPSIA_CHAIN_ID || "46630");
  if (!chain || typeof fetchImpl !== "function") return { status: "degraded", error: "RPC is not configured." };
  try {
    const response = await fetchImpl(chain.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`RPC failed (${response.status}).`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message || "RPC returned an error.");
    const chainId = Number.parseInt(String(body.result || "0x0"), 16);
    if (chainId !== Number(chain.chainId)) throw new Error(`RPC chain mismatch: expected ${chain.chainId}, received ${chainId}.`);
    last = { status: "ok", checkedAt: new Date().toISOString(), error: null, chainId: String(chainId) };
  } catch (error) { last = { status: "degraded", checkedAt: new Date().toISOString(), error: error.message, chainId: null }; }
  return getTokenHealth();
}
function refreshRpc(fetchImpl) { if (!checking) checking = checkRpc(fetchImpl).finally(() => { checking = null; }); return checking; }
function getTokenHealth() {
  const asset = getAsset("PERPSIA");
  return { rpc: { ...last }, asset: { symbol: asset.symbol, status: asset.status, configured: Boolean(asset.contractAddress), network: asset.chain?.network || null }, staking: { mode: String(process.env.PERPSIA_STAKING_MODE || "mock"), configured: Boolean(process.env.PERPSIA_STAKING_CONTRACT_ADDRESS), contractConfigured: Boolean(process.env.PERPSIA_STAKING_CONTRACT_ADDRESS) }, indexer: { status: "not_configured", checkpoint: null } };
}
module.exports = { checkRpc, getTokenHealth, refreshRpc };
