# Testnet contract boundary

`MockPerpsIA.sol` and `PerpsIAStakingV1.sol` are testnet-only source artifacts. They are not audited, deployed, or approved for mainnet.

The staking contract is intentionally non-upgradeable and has no rewards, inflation, fees, or admin withdrawal of the staked token. It supports partial/full unstaking, pause/unpause, two-step ownership transfer, multisig-compatible ownership, protected staking-token rescue, and rejects fee-on-transfer tokens. A production review must still cover compiler output, formal assumptions, token behavior, deployment ownership, and event/indexer reconciliation.

Deployment is blocked until a Solidity toolchain, a funded Robinhood Chain Testnet deployer wallet, a test token configuration, and explicit operator approval are available. Never place a private key in source control or the frontend.

Compile deterministically with the pinned dev dependency:

```bash
npm run contracts:compile
```

Use `npm run contracts:compile -- --write` only to generate local ignored artifacts for a deployment tool. The source has compiled locally, but compilation is not a security audit.
