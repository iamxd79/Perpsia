const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

process.env.PERPSIA_DB_PATH = path.join(
  os.tmpdir(),
  "perpsia-identity-" + process.pid + "-" + Date.now() + ".db",
);

const {
  consumeTelegramLinkSession,
  createTelegramLinkSession,
  getAccountIdentities,
  getIdentity,
  getOrCreateIdentity,
  getOrCreateTelegramAccount,
  inspectTelegramLinkSession,
} = require("../services/accountIdentity");

test("keeps Telegram identity stable and creates a one-time web link", () => {
  const first = getOrCreateTelegramAccount("telegram-test-1", { username: "alice" });
  const second = getOrCreateTelegramAccount("telegram-test-1", { username: "alice-updated" });
  assert.equal(first.account_id, second.account_id);

  const session = createTelegramLinkSession("telegram-test-1", {
    appUrl: "https://example.test",
  });
  assert.match(session.url, /^https:\/\/example\.test\/link\?token=/);
  assert.equal(getIdentity("telegram", "telegram-test-1").account_id, first.account_id);

  const linked = consumeTelegramLinkSession(session.token, "privy", "did:privy:alice");
  assert.equal(linked.account_id, first.account_id);
  assert.equal(getAccountIdentities(first.account_id).map((item) => item.provider).sort().join(","), "privy,telegram");
  assert.throws(() => consumeTelegramLinkSession(session.token, "privy", "did:privy:alice"), /expired or was already used/);
});

test("rejects malformed, expired, and conflicting links without consuming them", async () => {
  assert.deepEqual(inspectTelegramLinkSession("not-a-real-token"), { status: "invalid" });

  const expired = createTelegramLinkSession("telegram-expiring", { ttlMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(inspectTelegramLinkSession(expired.token).status, "expired");
  assert.throws(() => consumeTelegramLinkSession(expired.token, "privy", "did:privy:expired"), /expired or was already used/);

  const existing = getOrCreateTelegramAccount("telegram-conflict");
  getOrCreateIdentity("privy", "did:privy:other-account");
  const conflict = createTelegramLinkSession("telegram-conflict");
  assert.throws(
    () => consumeTelegramLinkSession(conflict.token, "privy", "did:privy:other-account"),
    /already linked to another/,
  );
  assert.equal(inspectTelegramLinkSession(conflict.token).status, "valid");
  const linked = consumeTelegramLinkSession(conflict.token, "privy", "did:privy:new-account");
  assert.equal(linked.account_id, existing.account_id);
});
