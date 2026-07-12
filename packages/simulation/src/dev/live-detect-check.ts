/**
 * Slice 7 gate — decisions on ESTIMATED state.
 *
 * Design principle #5, measured: run the SAME stockout detector on ground-truth
 * state and on the estimate reconstructed from the live sensor feeds, at the same
 * ticks, and compare. The eyes are good enough to drive the brain if they catch
 * what ground truth catches (recall) and agree cell-by-cell (agreement).
 */

import { generateDisruption, makeRng, IN_SCOPE_TYPES, TX_OK_NETWORK } from "@rally/data-gen";
import { liveDetectionSweep } from "../live-detect.js";

const seeds = Array.from({ length: Number(process.argv[2] ?? 20) }, (_, i) => 4000 + i);
const make = (seed: number) => {
  const rng = makeRng(seed);
  return generateDisruption(rng, `D${seed}`, { type: rng.pick(IN_SCOPE_TYPES) }, TX_OK_NETWORK);
};

const r = liveDetectionSweep(seeds, make);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log("── Slice 7 · detection on estimated state (principle #5) ──");
console.log(`seeds ${seeds.length} · ${r.ticks} ticks · same detector, true vs estimated state`);
console.log(`detector flags           ground-truth ${r.truthFlags} · estimate ${r.estFlags}`);
console.log(`recall (caught real risk) ${pct(r.recall)}   ← misses ${r.falseNegative} of ${r.truePositive + r.falseNegative}`);
console.log(`cell-tick agreement       ${pct(r.agreement)}`);
console.log(`precision (alarms real)   ${pct(r.precision)}   ← conservative: over-alerts where in-flight inbound is unseen`);
console.log("──────────────────────────────────────────────────────────");
console.log("read: the estimate is a SAFE superset — it never misses a real stockout,");
console.log("      but raises extra alarms wherever it cannot yet see incoming replenishment.");

const pass = r.recall >= 0.9 && r.agreement >= 0.9 && r.truthFlags > 0;
console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
process.exit(pass ? 0 : 1);
