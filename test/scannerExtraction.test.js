const test = require("node:test");
const assert = require("node:assert/strict");

const { extractSymbolsFromScan } = require("../services/scannerV2");

test("extracts candidates from the live ranked-primary CMC report heading", () => {
  const payload = {
    result: {
      data: {
        decision_report: {
          analysis: [
            "### Scan Funnel Overview",
            "The scan completed.",
            "### Ranked Primary Candidates",
            "1.  **BTW (Long Exhaustion Risk):** review the setup.",
            "2.  **USDC (Watch):** review the setup.",
            "3.  **CASHCAT (Crowded Chop):** review the setup.",
            "### Secondary Candidates",
            "1.  **EUR:** extended review.",
          ].join(String.fromCharCode(10)),
        },
      },
    },
  };
  assert.deepEqual(extractSymbolsFromScan(payload), ["BTW", "USDC", "CASHCAT"]);
});
