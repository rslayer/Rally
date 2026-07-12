/**
 * Phase 3 acceptance gate.
 *
 * Across seeds, the resolver must reduce total stockout-hours versus the `hold`
 * baseline — the same scenario run with the resolver switched off — measured on
 * ground truth. Each in-scope disruption is run both ways from the same seed.
 */

import type { Disruption } from "@rally/domain";
import { makeRng, generateDisruption, IN_SCOPE_TYPES, TX_OK_NETWORK } from "@rally/data-gen";
import { makeConfig } from "../config.js";
import { runScenario } from "../run.js";

const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i);

let holdHours = 0;
let resolveHours = 0;
let resolved = 0;
let escalated = 0;
let totalCost = 0;

for (const seed of SEEDS) {
  const rng = makeRng(seed);
  const type = rng.pick(IN_SCOPE_TYPES);
  const dis: Disruption = generateDisruption(rng, `D-${seed}`, { type, startMin: 36, startMax: 120 }, TX_OK_NETWORK);

  const hold = runScenario(makeConfig({ seed, disruptions: [dis], resolverEnabled: false }));
  const live = runScenario(makeConfig({ seed, disruptions: [dis], resolverEnabled: true }));

  holdHours += hold.metrics.stockoutHours;
  resolveHours += live.metrics.stockoutHours;
  totalCost += live.metrics.actionCost;
  for (const d of live.decisions) {
    if (d.outcome === "resolved") resolved++;
    else escalated++;
  }
}

const reduction = holdHours > 0 ? (1 - resolveHours / holdHours) * 100 : 0;

console.log("── Phase 3 · resolver vs hold baseline ───────────────────");
console.log(`seeds                    ${SEEDS.length} (in-scope disruptions)`);
console.log(`stockout-hours  hold     ${holdHours}`);
console.log(`stockout-hours  resolver ${resolveHours}`);
console.log(`reduction                ${reduction.toFixed(1)}%`);
console.log(`decisions  resolved      ${resolved}`);
console.log(`decisions  escalated     ${escalated}`);
console.log(`resolver action cost     $${Math.round(totalCost).toLocaleString()}`);

const pass = resolveHours < holdHours && holdHours > 0;
console.log("──────────────────────────────────────────────────────────");
console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
process.exit(pass ? 0 : 1);
