/**
 * Slice 9 gate — the continuous control tower, running.
 *
 * Across seeds, the full loop (ingest → estimate → detect → resolve on estimated
 * state) must actually ACT — produce resolve/escalate decisions — and catch the
 * majority of the stockout risks the ground truth surfaced. The estimate is not
 * perfect, so it occasionally misses one; the gate requires it to run, act, and
 * cover most.
 */

import { generateDisruption, makeRng, IN_SCOPE_TYPES, TX_OK_NETWORK } from "@rally/data-gen";
import { runControlTower } from "../control-tower.js";

const seeds = Array.from({ length: Number(process.argv[2] ?? 16) }, (_, i) => 4000 + i);

let resolved = 0, escalated = 0, truth = 0, caught = 0, cyclesWithFeeds = 0, totalCycles = 0;
for (const seed of seeds) {
  const rng = makeRng(seed);
  const dis = generateDisruption(rng, `CT${seed}`, { type: rng.pick(IN_SCOPE_TYPES), startMin: 48, startMax: 96 }, TX_OK_NETWORK);
  const r = await runControlTower(seed, [dis]);
  resolved += r.resolved;
  escalated += r.escalated;
  truth += r.truthStockoutCells;
  caught += r.caughtStockoutCells;
  totalCycles += r.cycles.length;
  cyclesWithFeeds += r.cycles.filter((c) => c.freshFeeds > 0).length;
}

const coverage = truth ? caught / truth : 1;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log("── Slice 9 · control tower running end to end ──");
console.log(`seeds ${seeds.length} · ${totalCycles} cycles (${cyclesWithFeeds} ingested fresh feeds)`);
console.log(`decisions taken          ${resolved} resolved · ${escalated} escalated`);
console.log(`stockout coverage        ${caught}/${truth} ground-truth risk cells flagged (${pct(coverage)})`);
console.log("──────────────────────────────────────────────────────────");
console.log("read: the whole system runs on sensor-grounded state — ingest, estimate,");
console.log("      detect, and decide — catching most real risks and acting on them.");

const pass = resolved + escalated > 0 && coverage >= 0.6 && cyclesWithFeeds === totalCycles;
console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
process.exit(pass ? 0 : 1);
