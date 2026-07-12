/**
 * Slice 8 gate — the ASN feed closes the inbound-visibility gap Slice 7 measured.
 *
 * Run the same detection-fidelity sweep twice: once with the advance-ship-notice
 * feed suppressed (the Slice-7 world), once with it present. The ASN declares
 * destination + quantity + ETA up front, so the estimator sees in-flight inbound
 * completely — the false alarms collapse while recall stays pinned at 100%.
 */

import { generateDisruption, makeRng, IN_SCOPE_TYPES, TX_OK_NETWORK } from "@rally/data-gen";
import { liveDetectionSweep } from "../live-detect.js";

const seeds = Array.from({ length: Number(process.argv[2] ?? 20) }, (_, i) => 4000 + i);
const make = (seed: number) => {
  const rng = makeRng(seed);
  return generateDisruption(rng, `D${seed}`, { type: rng.pick(IN_SCOPE_TYPES) }, TX_OK_NETWORK);
};

const without = liveDetectionSweep(seeds, make, { ignoreAsn: true });
const withAsn = liveDetectionSweep(seeds, make, { ignoreAsn: false });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log("── Slice 8 · ASN / EDI-856 feed closes the inbound gap ──");
console.log(`seeds ${seeds.length} · same detector, ground-truth vs estimated state`);
console.log(`                        without ASN     with ASN`);
console.log(`recall (real risks)      ${pct(without.recall).padStart(7)}        ${pct(withAsn.recall).padStart(7)}`);
console.log(`precision (alarms real)  ${pct(without.precision).padStart(7)}        ${pct(withAsn.precision).padStart(7)}`);
console.log(`cell-tick agreement      ${pct(without.agreement).padStart(7)}        ${pct(withAsn.agreement).padStart(7)}`);
console.log(`estimate flags           ${String(without.estFlags).padStart(7)}        ${String(withAsn.estFlags).padStart(7)}   (ground truth ${withAsn.truthFlags})`);
console.log("──────────────────────────────────────────────────────────");
const lift = withAsn.precision - without.precision;
console.log(`ASN precision lift        +${(lift * 100).toFixed(1)} points, recall held at ${pct(withAsn.recall)}`);
console.log("read: a gap discovered by measurement (Slice 7), closed by the right feed (Slice 8).");

// The fix must materially lift precision AND keep recall high — no regressions.
const pass = withAsn.recall >= 0.9 && withAsn.precision >= 0.8 && lift >= 0.3;
console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
process.exit(pass ? 0 : 1);
