/**
 * Slice 11 gate — the estimated-path scorecard.
 *
 * The Slice-1 scorecard grades a resolver that decides on GROUND-TRUTH state.
 * This runs the SAME oracle, but with the resolver deciding on state estimated
 * from the live feeds (effects replayed onto the true world). The gap between the
 * two scorecards is the price of imperfect eyes on DECISION quality — the
 * ultimate principle-5 number.
 */

import { buildScorecard } from "../scorer.js";

const seeds = Array.from({ length: Number(process.argv[2] ?? 12) }, (_, i) => 4000 + i);

const gt = buildScorecard(seeds, { estimated: false });
const est = buildScorecard(seeds, { estimated: true });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const injectedDanger = (r: typeof gt) => r.records.filter((x) => x.category === "injected_unresolvable" && (x.cell === "falseResolve" || x.cell === "silentMiss")).length;

console.log("── Slice 11 · scorecard: ground truth vs estimated state ──");
console.log(`seeds ${seeds.length} · same oracle · resolver decides on true vs estimated state`);
console.log(`                              ground-truth     estimated`);
console.log(`touchless (all)               ${pct(gt.scorecard.aggregateTouchlessRate).padStart(8)}      ${pct(est.scorecard.aggregateTouchlessRate).padStart(8)}`);
console.log(`escalation safety recall      ${pct(gt.scorecard.escalationSafetyRecall).padStart(8)}      ${pct(est.scorecard.escalationSafetyRecall).padStart(8)}`);
console.log(`escalation precision          ${pct(gt.scorecard.escalationPrecision).padStart(8)}      ${pct(est.scorecard.escalationPrecision).padStart(8)}`);
console.log(`dangerous false-resolves      ${String(gt.dangerous).padStart(8)}      ${String(est.dangerous).padStart(8)}`);
console.log(`↳ injected falsely resolved   ${String(injectedDanger(gt)).padStart(8)}      ${String(injectedDanger(est)).padStart(8)}`);
console.log("──────────────────────────────────────────────────────────");
const touchlessCost = gt.scorecard.aggregateTouchlessRate - est.scorecard.aggregateTouchlessRate;
console.log(`the price of imperfect eyes: −${(touchlessCost * 100).toFixed(1)} pts touchless, safety recall held at ${pct(est.scorecard.escalationSafetyRecall)}`);
console.log("read: deciding on sensor-grounded state costs touchless rate and adds a few");
console.log("      dangerous resolves — but it stays safe. Better eyes ⇒ closer to the oracle.");

// The estimated path must stay safe and must not out-perform the oracle.
const pass =
  est.scorecard.escalationSafetyRecall >= 0.85 &&
  est.scorecard.aggregateTouchlessRate <= gt.scorecard.aggregateTouchlessRate + 1e-9 &&
  est.scorecard.aggregateTouchlessRate > 0;
console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
process.exit(pass ? 0 : 1);
