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
  consumeWebTelegramLinkSession,
  createTelegramLinkSession,
  createWebTelegramLinkSession,
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
  assert.throws(() => consumeTelegramLinkSession(session.token, "privy", "did:privy:alice"), (error) => error.code === "LINK_USED");
});

test("rejects malformed, expired, and conflicting links without consuming them", async () => {
  assert.deepEqual(inspectTelegramLinkSession("not-a-real-token"), { status: "invalid" });

  const expired = createTelegramLinkSession("telegram-expiring", { ttlMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(inspectTelegramLinkSession(expired.token).status, "expired");
  assert.throws(() => consumeTelegramLinkSession(expired.token, "privy", "did:privy:expired"), (error) => error.code === "LINK_EXPIRED");

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

test("supports web-first account creation and reverse Telegram linking", () => {
  const webIdentity = getOrCreateIdentity("privy", "did:privy:web-first");
  const session = createWebTelegramLinkSession(webIdentity.account_id, {
    appUrl: "https://example.test",
    botUsername: "perpsia_bot",
  });
  assert.match(session.telegramUrl, /^https:\/\/t\.me\/perpsia_bot\?start=link_/);
  assert.equal(inspectTelegramLinkSession(session.token).status, "valid");

  const telegram = consumeWebTelegramLinkSession(session.token, "telegram-web-first", { username: "webfirst" });
  assert.equal(telegram.account_id, webIdentity.account_id);
  assert.deepEqual(getAccountIdentities(webIdentity.account_id).map((item) => item.provider).sort(), ["privy", "telegram"]);
  assert.throws(() => consumeWebTelegramLinkSession(session.token, "telegram-web-first"), (error) => error.code === "LINK_USED");
});

test("rejects conflicting reverse links and keeps the token usable", () => {
  const target = getOrCreateIdentity("privy", "did:privy:reverse-target");
  const existingTelegram = getOrCreateTelegramAccount("telegram-already-owned");
  assert.notEqual(target.account_id, existingTelegram.account_id);
  const session = createWebTelegramLinkSession(target.account_id);

  assert.throws(
    () => consumeWebTelegramLinkSession(session.token, "telegram-already-owned"),
    (error) => error.code === "IDENTITY_CONFLICT",
  );
  assert.equal(inspectTelegramLinkSession(session.token).status, "valid");
});
