"use strict";

const { verifyAccessToken } = require("@privy-io/node");

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

module.exports = { getPrivyConfig, verifyPrivyAccessToken };
