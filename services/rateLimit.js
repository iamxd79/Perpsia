const userCooldowns = new Map();

const COOLDOWNS = {
  scan: 60 * 1000,
  analyze: 45 * 1000,
  risk: 10 * 1000,
  intent: 8 * 1000,
};

function checkCooldown(chatId, action) {
  const key = `${chatId}:${action}`;
  const now = Date.now();
  const cooldownMs = COOLDOWNS[action] || 10 * 1000;
  const lastUsed = userCooldowns.get(key) || 0;
  const remaining = cooldownMs - (now - lastUsed);

  if (remaining > 0) {
    return {
      allowed: false,
      remainingSeconds: Math.ceil(remaining / 1000),
    };
  }

  userCooldowns.set(key, now);

  return {
    allowed: true,
    remainingSeconds: 0,
  };
}

module.exports = {
  checkCooldown,
};