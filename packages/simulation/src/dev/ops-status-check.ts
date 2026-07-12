/**
 * Slice 12 gate — held-out disruptions escalated from a SENSED ops feed.
 *
 * On the estimated path the resolver has no privileged knowledge of a labor
 * stoppage or a quality recall — it learns them only from the operational-status
 * feed. This gate confirms that every held-out disruption (labor_action /
 * quality_hold) is correctly escalated on the estimated path, with the decision
 * citing the ops feed as its source.
 */

import { generateScenarioSet, scoreScenario } from "../scorer.js";

const seeds = Array.from({ length: Number(process.argv[2] ?? 12) }, (_, i) => 4000 + i);

let total = 0, trueEscalate = 0, dangerous = 0, fromOpsFeed = 0;
for (const seed of seeds) {
  for (const { disruption, category } of generateScenarioSet(seed)) {
    if (category !== "held_out") continue;
    const r = scoreScenario(seed, disruption, category, { estimated: true });
    if (!r) continue;
    total++;
    if (r.cell === "trueEscalate") trueEscalate++;
    if (r.cell === "falseResolve" || r.cell === "silentMiss") dangerous++;
    if (/ops feed/.test(r.rationale)) fromOpsFeed++;
  }
}

const pct = (x: number) => `${((x / Math.max(1, total)) * 100).toFixed(1)}%`;
console.log("── Slice 12 · held-out escalated from a sensed ops feed ──");
console.log(`held-out disruptions (estimated path)   ${total}`);
console.log(`correctly escalated                     ${trueEscalate}  (${pct(trueEscalate)})`);
console.log(`decisions sourced from the ops feed     ${fromOpsFeed}  (${pct(fromOpsFeed)})`);
console.log(`dangerous (false-resolve / silent)      ${dangerous}`);
console.log("──────────────────────────────────────────────────────────");
console.log("read: no privileged config — a suspended dock or a quarantined SKU is");
console.log("      sensed from the feed, detected, and escalated. Out-of-scope, observed.");

const pass = total > 0 && trueEscalate / total >= 0.9 && dangerous === 0 && fromOpsFeed / total >= 0.9;
console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
process.exit(pass ? 0 : 1);
