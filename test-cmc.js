const { findSkill } = require("./services/cmcClient");

async function testConnection() {
  console.log("Connecting to CMC Skill Hub...");

  try {
    const result = await findSkill("btc price");

    console.log("CMC Skill Hub connected successfully.");
    console.dir(result, { depth: null });
  } catch (error) {
    console.error("CMC connection failed:");
    console.error(error);
  }
}

testConnection();