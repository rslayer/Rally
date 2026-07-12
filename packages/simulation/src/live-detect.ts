/**
 * Slice 7 — decisions on ESTIMATED state.
 *
 * Slice 1 proved the loop on ground truth. But in the real world the resolver
 * never sees ground truth — it sees an ESTIMATE reconstructed from imperfect
 * sensor feeds. This module runs the same stockout detector on that estimate and
 * measures how well the sensor-grounded view drives the decision versus the
 * ground-truth risks the closed world actually produced.
 *
 * This is the direct test of design principle #5: a better estimate of true
 * physical state is a better stockout prediction. It also surfaces, honestly,
 * where the estimate is blind — the telematics feed carries no quantity/SKU and
 * the WMS ship-confirm carries no destination, so in-flight inbound is only
 * partially visible; the detector leans pessimistic where it cannot see incoming
 * replenishment. The report shows exactly what that costs.
 */

import type { Disruption, ScenarioState, StockoutRisk } from "@rally/domain";
import { DC_IDS, TX_OK_NETWORK, makeRng } from "@rally/data-gen";
import { makeConfig } from "./config.js";
import { initWorld, snapshot, RISK_HORIZON_HOURS, MATERIALITY_UNITS } from "./inventory-kernel.js";
import { stepSimulation } from "./step.js";
import { projectCell } from "./projection.js";
import { estimateState } from "./state-estimator.js";
import type { SimConfig } from "./types.js";

const cellK = (f: string, s: string) => `${f}|${s}`;

/**
 * Run the projection-based detector over a ScenarioState whose on-hand comes
 * from the ESTIMATE. Known planning parameters (reorder policy, production
 * schedule, demand model) come from config; only the physical on-hand is sensed.
 * In-flight inbound is not observed, so it is deliberately excluded.
 */
export function detectOnState(config: SimConfig, state: ScenarioState, hour: number): StockoutRisk[] {
  const world = initWorld(config, makeRng(config.seed));
  world.hour = hour;
  for (const p of state.positions) {
    const cell = world.positions.get(cellK(p.facilityId, p.skuId));
    if (cell) {
      cell.onHandUnits = p.onHandUnits;
      cell.allocatedUnits = p.allocatedUnits;
    }
  }
  // In-flight inbound reconstructed by the estimator (WMS ship-confirm qty/SKU
  // joined to telematics dest via shipmentRef). Only replenishment/transfer to a
  // DC counts as inbound cover; drop anything with unknown quantity.
  world.shipments = state.shipments
    .filter((s) => s.kind !== "customer" && s.status === "in_transit" && s.quantityUnits > 0 && s.skuId !== "unknown")
    .map((s) => ({ ...s, confidence: 1 }));

  const risks: StockoutRisk[] = [];
  for (const dc of DC_IDS) {
    for (const sku of config.network.skus) {
      const proj = projectCell(world, dc, sku.skuId, hour, RISK_HORIZON_HOURS);
      if (!proj.crosses || proj.shortfallUnits < MATERIALITY_UNITS) continue;
      const conf = state.positions.find((p) => p.facilityId === dc && p.skuId === sku.skuId)?.confidence ?? 0.5;
      risks.push({
        riskId: `EST-${dc}-${sku.skuId}-${hour}`,
        facilityId: dc,
        skuId: sku.skuId,
        detectedAtHour: hour,
        hoursToStockout: proj.hoursToStockout,
        projectedShortfallUnits: proj.shortfallUnits,
        confidence: conf,
        drivers: ["estimated from live feeds"],
      });
    }
  }
  return risks;
}

export interface LiveDetectionReport {
  ticks: number;
  truthFlags: number; // (cell,tick) the detector flags on GROUND-TRUTH state
  estFlags: number; //   (cell,tick) the detector flags on ESTIMATED state
  truePositive: number; // flagged on both
  falseNegative: number; // truth flagged, estimate missed
  falsePositive: number; // estimate flagged, truth clear
  recall: number; // TP / (TP + FN) — did the estimate catch what ground truth saw?
  precision: number; // TP / (TP + FP) — were the estimate's alarms real?
  agreement: number; // fraction of (cell,tick) where truth and estimate agree
}

/** Detected at-risk cells as a Set, given a state fed through the SAME detector. */
function flaggedCells(config: SimConfig, state: ScenarioState, hour: number): Set<string> {
  return new Set(detectOnState(config, state, hour).map((r) => cellK(r.facilityId, r.skuId)));
}

/**
 * Principle #5, measured: run the SAME detector on ground-truth state and on the
 * estimate reconstructed from live feeds, at the same ticks, and compare. High
 * agreement means the eyes are good enough to drive the brain.
 */
export function liveDetectionFidelity(
  seed: number,
  disruption: Disruption,
  opts: { ignoreAsn?: boolean } = {},
): LiveDetectionReport {
  const config = makeConfig({ seed, disruptions: [disruption], resolverEnabled: false, emitFeeds: true });
  const cells = DC_IDS.length * config.network.skus.length;

  // Ground-truth run: capture the true state at each tick (processed-hour
  // convention, so the estimate's feed labels line up) + the feed stream.
  const world = initWorld(config, makeRng(seed));
  const truthAt = new Map<number, ScenarioState>();
  const tickSet = new Set<number>();
  for (let T = 24; T <= config.horizonHours - 12; T += 12) tickSet.add(T);
  for (let h = 0; h < config.horizonHours; h++) {
    stepSimulation(world);
    const processed = world.hour - 1;
    if (tickSet.has(processed)) truthAt.set(processed, snapshot(world));
  }
  const allFeeds = world.feedSink ?? [];
  const feeds = opts.ignoreAsn ? allFeeds.filter((m) => m.feedType !== "asn") : allFeeds;

  let tp = 0, fn = 0, fp = 0, agree = 0, truthFlags = 0, estFlags = 0, ticks = 0;
  for (const T of [...tickSet].sort((a, b) => a - b)) {
    const truthState = truthAt.get(T);
    if (!truthState) continue;
    ticks++;
    const truth = flaggedCells(config, truthState, T);
    const est = flaggedCells(config, estimateState(feeds, T, TX_OK_NETWORK).state, T);
    truthFlags += truth.size;
    estFlags += est.size;
    for (const c of truth) if (est.has(c)) tp++; else fn++;
    for (const c of est) if (!truth.has(c)) fp++;
    // agreement over all cells (both flagged or both clear)
    for (const dc of DC_IDS)
      for (const sku of config.network.skus) {
        const c = cellK(dc, sku.skuId);
        if (truth.has(c) === est.has(c)) agree++;
      }
  }

  const denomAgree = ticks * cells;
  return {
    ticks,
    truthFlags,
    estFlags,
    truePositive: tp,
    falseNegative: fn,
    falsePositive: fp,
    recall: tp + fn ? Number((tp / (tp + fn)).toFixed(3)) : 1,
    precision: tp + fp ? Number((tp / (tp + fp)).toFixed(3)) : 1,
    agreement: denomAgree ? Number((agree / denomAgree).toFixed(3)) : 1,
  };
}

/** Aggregate across seeds for a stable read. */
export function liveDetectionSweep(
  seeds: number[],
  make: (seed: number) => Disruption,
  opts: { ignoreAsn?: boolean } = {},
): LiveDetectionReport {
  let tp = 0, fn = 0, fp = 0, truthFlags = 0, estFlags = 0, ticks = 0, agreeCells = 0, totalCells = 0;
  for (const seed of seeds) {
    const r = liveDetectionFidelity(seed, make(seed), opts);
    tp += r.truePositive;
    fn += r.falseNegative;
    fp += r.falsePositive;
    truthFlags += r.truthFlags;
    estFlags += r.estFlags;
    ticks += r.ticks;
    agreeCells += r.agreement * r.ticks; // agreement is per-tick-cell fraction; reweight below
    totalCells += r.ticks;
  }
  return {
    ticks,
    truthFlags,
    estFlags,
    truePositive: tp,
    falseNegative: fn,
    falsePositive: fp,
    recall: tp + fn ? Number((tp / (tp + fn)).toFixed(3)) : 1,
    precision: tp + fp ? Number((tp / (tp + fp)).toFixed(3)) : 1,
    agreement: totalCells ? Number((agreeCells / totalCells).toFixed(3)) : 1,
  };
}
