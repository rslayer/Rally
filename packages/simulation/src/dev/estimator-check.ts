/**
 * Phase 2 acceptance gate.
 *
 * State rebuilt purely from the emitted feed stream must match the direct-sim
 * ground truth within tolerance — including at hours BETWEEN lagging inventory
 * snapshots, where the estimator has to interpolate from the warehouse stream.
 */

import type { AnyFeedMessage, ScenarioState } from "@rally/domain";
import { makeRng, generateDisruption, TX_OK_NETWORK } from "@rally/data-gen";
import { makeConfig } from "../config.js";
import { initWorld, snapshot } from "../inventory-kernel.js";
import { stepSimulation } from "../step.js";
import { estimateState } from "../state-estimator.js";

const seed = Number(process.argv[2] ?? 42);
const rng = makeRng(seed);
const disruptions = [
  generateDisruption(rng, "D1", { type: "demand_spike", startMin: 36, startMax: 72 }, TX_OK_NETWORK),
  generateDisruption(rng, "D2", { type: "supply_shortfall", startMin: 80, startMax: 140 }, TX_OK_NETWORK),
];
const config = makeConfig({ seed, disruptions, resolverEnabled: false, emitFeeds: true, horizonHours: 14 * 24 });

// Manual run so we can capture ground truth at non-snapshot-aligned probe hours.
const world = initWorld(config, makeRng(seed));
const probeHours = [5, 17, 29, 41, 77, 101, 149, 197, 233, 293, 331];
const truthAt = new Map<number, ScenarioState>();
for (let h = 0; h < config.horizonHours; h++) {
  stepSimulation(world);
  if (probeHours.includes(world.hour)) truthAt.set(world.hour, snapshot(world));
}
const feeds: AnyFeedMessage[] = world.feedSink ?? [];

let sumRel = 0;
let n = 0;
let maxRel = 0;
let worst = "";
let maxDriftReported = 0;

for (const h of probeHours) {
  const truth = truthAt.get(h);
  if (!truth) continue;
  const { state: est, drift } = estimateState(feeds, h, TX_OK_NETWORK);
  maxDriftReported = Math.max(maxDriftReported, drift.maxAbs);
  for (const t of truth.positions) {
    const e = est.positions.find((p) => p.facilityId === t.facilityId && p.skuId === t.skuId);
    const rel = Math.abs((e?.onHandUnits ?? 0) - t.onHandUnits) / Math.max(50, t.onHandUnits);
    sumRel += rel;
    n++;
    if (rel > maxRel) {
      maxRel = rel;
      worst = `${t.facilityId}/${t.skuId} est=${e?.onHandUnits} truth=${t.onHandUnits}`;
    }
  }
}

const meanRel = sumRel / Math.max(1, n);
const TOL_MEAN = 0.03;
const TOL_MAX = 0.15;

console.log("── Phase 2 · state estimator ─────────────────────────────");
console.log(`seed                     ${seed}`);
console.log(`feed messages            ${feeds.length}`);
console.log(`cells compared           ${n} across ${probeHours.length} probe hours`);
console.log(`mean rel error           ${(meanRel * 100).toFixed(2)}%   (tol ${TOL_MEAN * 100}%)`);
console.log(`max rel error            ${(maxRel * 100).toFixed(2)}%   (tol ${TOL_MAX * 100}%)`);
console.log(`worst cell               ${worst}`);
console.log(`reconciliation drift max ${maxDriftReported.toFixed(1)} units`);
// A quick association read: how many estimated assets got a real (non-inferred) ref.
const { state: sample } = estimateState(feeds, 150, TX_OK_NETWORK);
const associated = sample.assets.filter((a) => !a.associatedShipmentId?.startsWith("est:")).length;
console.log(`assets tracked @150h     ${sample.assets.length} (ref-associated ${associated}, geo-inferred ${sample.assets.length - associated})`);
console.log(`overall confidence @150h ${sample.overallConfidence}`);

const pass = meanRel <= TOL_MEAN && maxRel <= TOL_MAX;
console.log("──────────────────────────────────────────────────────────");
console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
process.exit(pass ? 0 : 1);
