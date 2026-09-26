"use strict";

const { PrivyClient, verifyAccessToken } = require("@privy-io/node");

let client;

function getPrivyConfig() {
  return {
    appId: String(process.env.PRIVY_APP_ID || "").trim(),
    verificationKey: String(process.env.PRIVY_VERIFICATION_KEY || "").trim(),
  };
}

async function verifyPrivyAccessToken(accessToken) {
  const token = String(accessToken || "").trim();
  const { appId, verificationKey } = getPrivyConfig();
  if (!appId || !verificationKey) {
    const error = new Error("Privy server verification is not configured.");
    error.code = "PRIVY_NOT_CONFIGURED";
    throw error;
  }
  if (!token || token.length > 8192) {
    const error = new Error("A valid Privy access token is required.");
    error.code = "INVALID_PRIVY_TOKEN";
    throw error;
  }
  const verified = await verifyAccessToken({
    access_token: token,
    app_id: appId,
    verification_key: verificationKey,
  });
  if (!verified?.user_id) {
    const error = new Error("Privy access token has no user subject.");
    error.code = "INVALID_PRIVY_TOKEN";
    throw error;
  }
  return verified;
}

function getPrivyClient() {
  const appId = String(process.env.PRIVY_APP_ID || "").trim();
  const appSecret = String(process.env.PRIVY_APP_SECRET || "").trim();
  if (!appId || !appSecret) {
    const error = new Error("Privy server client is not configured.");
    error.code = "PRIVY_SERVER_NOT_CONFIGURED";
    throw error;
  }
  if (!client) client = new PrivyClient({ appId, appSecret });
  return client;
}

async function getPrivyUserWallets(userId) {
  const user = await getPrivyClient().users()._get(String(userId));
  return (user?.linked_accounts || [])
    .filter((account) => account && ["wallet", "smart_wallet"].includes(account.type) && account.address)
    .map((account) => ({
      address: account.address,
      chainType: account.chain_type || null,
      walletType: account.type,
      provider: account.wallet_client_type || account.connector_type || null,
      custody: account.wallet_client_type === "privy" || account.type === "smart_wallet" ? "embedded" : "external",
      ownershipStatus: "verified",
    }));
}

module.exports = { getPrivyConfig, getPrivyUserWallets, verifyPrivyAccessToken };
