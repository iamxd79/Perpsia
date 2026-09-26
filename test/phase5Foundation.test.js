const test = require("node:test");
const assert = require("node:assert/strict");

const { getChain } = require("../services/chainRegistry");
const { getAsset, validateAsset } = require("../services/assetRegistry");
const { encodeBalanceOf } = require("../services/tokenBalance");

test("registers official Robinhood Chain mainnet and testnet metadata", () => {
  assert.equal(getChain("eip155", "4663").rpcUrl, "https://rpc.mainnet.chain.robinhood.com");
  assert.equal(getChain("eip155", "46630").nativeSymbol, "ETH");
  assert.equal(getChain("eip155", "999"), null);
});

test("keeps PERPSIA explicit as a mock/test asset until a contract is verified", () => {
  const asset = validateAsset(getAsset("$perpsia"));
  assert.equal(asset.status, "mock");
  assert.equal(asset.contractAddress, null);
  assert.match(asset.metadata.disclaimer, /No mainnet token contract/);
});

test("encodes ERC-20 balanceOf calls without a mutable provider", () => {
  assert.equal(encodeBalanceOf("0x0000000000000000000000000000000000000001").length, 74);
  assert.match(encodeBalanceOf("0x0000000000000000000000000000000000000001"), /^0x70a08231/);
});
