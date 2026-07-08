const { findSkill } = require("./services/cmcClient");

async function inspectSkills() {
  const queries = [
    "detect accumulation breakout transition perpetual market input schema",
    "review perp orderbook pressure input schema",
    "analyze multi timeframe trend alignment input schema",
  ];

  for (const query of queries) {
    console.log("\n==============================");
    console.log("QUERY:", query);
    console.log("==============================");

    const result = await findSkill(query, 5);
    console.dir(result, { depth: null });
  }
}

inspectSkills().catch((error) => {
  console.error("Inspection failed:");
  console.error(error);
});