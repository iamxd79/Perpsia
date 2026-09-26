"use strict";

const CHAINS = {
  "eip155:4663": {
    namespace: "eip155", chainId: "4663", name: "Robinhood Chain",
    rpcUrl: process.env.PERPSIA_ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com", nativeSymbol: "ETH", network: "mainnet",
  },
  "eip155:46630": {
    namespace: "eip155", chainId: "46630", name: "Robinhood Chain Testnet",
    rpcUrl: process.env.PERPSIA_ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com", nativeSymbol: "ETH", network: "testnet",
  },
};

function chainKey(namespace, chainId) { return `${String(namespace || "eip155").toLowerCase()}:${String(chainId)}`; }
function getChain(namespace = "eip155", chainId = "46630") {
  const chain = CHAINS[chainKey(namespace, chainId)];
  return chain ? { ...chain } : null;
}
function listChains() { return Object.values(CHAINS).map((chain) => ({ ...chain })); }

module.exports = { chainKey, getChain, listChains };
