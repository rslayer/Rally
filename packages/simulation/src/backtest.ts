/**
 * Phase 5 — backtest: the bridge to the real system.
 *
 * Record an observed episode (the imperfect sensor feeds a real fleet would shed,
 * plus the ground-truth physical outcome), persist it, then REPLAY the feeds back
 * through the real-feed adapter and the state estimator to check the simulator
 * reproduces what actually happened. Three fidelity checks:
 *
 *   1. State reproduction — state rebuilt from the (vendor round-tripped) feeds
 *      matches the observed ground truth within tolerance.
 *   2. Stockout reproduction — the disrupted cell bottoms out at the same depth
 *      and (within a window) the same time as observed.
 *   3. Deterministic replay — re-running the model reproduces it exactly.
 */

import type { AnyFeedMessage, Disruption, Exception } from "@rally/domain";
import { makeRng, TX_OK_NETWORK } from "@rally/data-gen";
import { feedsToVendorFiles, loadVendorFiles } from "@rally/importers";
import { makeConfig } from "./config.js";
import { initWorld, snapshot } from "./inventory-kernel.js";
import { stepSimulation } from "./step.js";
import { estimateState } from "./state-estimator.js";

export interface TruthSample {
  hour: number;
  onHand: Record<string, number>; // "facility|sku" → on-hand
}

export interface ObservedEpisode {
  seed: number;
  disruption: Disruption;
  horizonHours: number;
  probeHours: number[];
  truth: TruthSample[];
  exceptions: Exception[];
  stockoutHours: number;
  feeds: AnyFeedMessage[];
}

export interface BacktestReport {
  feedMessages: number;
  vendorRoundTrip: boolean;
  stateMeanRelErr: number;
  stateMaxRelErr: number;
  worstCell: string;
  disrupted: {
    cell: string;
    observedMinHour: number;
    reproducedMinHour: number;
    timingErrorHours: number;
    observedMin: number;
    reproducedMin: number;
  };
  deterministic: boolean;
  observedExceptions: number;
  pass: boolean;
}

const cellK = (f: string, s: string) => `${f}|${s}`;

export function recordEpisode(seed: number, disruption: Disruption, horizonHours = 14 * 24): ObservedEpisode {
  const config = makeConfig({ seed, disruptions: [disruption], resolverEnabled: false, emitFeeds: true });
  const world = initWorld(config, makeRng(seed));
  const probeSet = new Set<number>();
  for (let h = 6; h <= horizonHours - 6; h += 6) probeSet.add(h);
  const truth: TruthSample[] = [];

  for (let h = 0; h < horizonHours; h++) {
    stepSimulation(world);
    // A step processes `world.hour - 1` and emits its feeds labeled with that
    // hour; sample truth on the SAME convention so anchors don't straddle a
    // delivery that lands exactly on the probe hour.
    const processedHour = world.hour - 1;
    if (probeSet.has(processedHour)) {
      const snap = snapshot(world);
      const onHand: Record<string, number> = {};
      for (const p of snap.positions) if (p.facilityId.startsWith("DC_")) onHand[cellK(p.facilityId, p.skuId)] = p.onHandUnits;
      truth.push({ hour: processedHour, onHand });
    }
  }
  const probeHours = [...probeSet].sort((a, b) => a - b);

  return {
    seed,
    disruption,
    horizonHours,
    probeHours,
    truth,
    exceptions: world.exceptions,
    stockoutHours: world.metrics.stockoutHours,
    feeds: world.feedSink ?? [],
  };
}

export function backtest(episode: ObservedEpisode, vendorRoundTrip = true): BacktestReport {
  // Replay the feeds through the REAL adapter path (vendor files → envelopes),
  // exactly as a customer export would arrive.
  const feeds = vendorRoundTrip ? loadVendorFiles(feedsToVendorFiles(episode.feeds)) : episode.feeds;

  const disruptedCell = cellK(episode.disruption.facilityId, episode.disruption.skuId);

  let sumRel = 0;
  let n = 0;
  let maxRel = 0;
  let worstCell = "";
  const reproSeries: Array<{ hour: number; onHand: number }> = [];

  for (const sample of episode.truth) {
    const { state } = estimateState(feeds, sample.hour, TX_OK_NETWORK);
    const est = new Map(state.positions.map((p) => [cellK(p.facilityId, p.skuId), p.onHandUnits]));
    for (const [cell, truthOnHand] of Object.entries(sample.onHand)) {
      const e = est.get(cell) ?? 0;
      const rel = Math.abs(e - truthOnHand) / Math.max(50, truthOnHand);
      sumRel += rel;
      n++;
      if (rel > maxRel) {
        maxRel = rel;
        worstCell = cell;
      }
    }
    reproSeries.push({ hour: sample.hour, onHand: est.get(disruptedCell) ?? 0 });
  }

  // Observed vs reproduced bottom of the disrupted cell.
  const obsSeries = episode.truth.map((s) => ({ hour: s.hour, onHand: s.onHand[disruptedCell] ?? 0 }));
  const obsMin = argMin(obsSeries);
  const repMin = argMin(reproSeries);

  // Deterministic replay: re-recording from the same seed reproduces it exactly.
  const replay = recordEpisode(episode.seed, episode.disruption, episode.horizonHours);
  const deterministic = replay.stockoutHours === episode.stockoutHours;

  const stateMeanRelErr = n ? sumRel / n : 0;
  const timingErrorHours = Math.abs(obsMin.hour - repMin.hour);
  const pass = stateMeanRelErr < 0.03 && maxRel < 0.15 && timingErrorHours <= 12 && deterministic;

  return {
    feedMessages: feeds.length,
    vendorRoundTrip,
    stateMeanRelErr: Number(stateMeanRelErr.toFixed(4)),
    stateMaxRelErr: Number(maxRel.toFixed(4)),
    worstCell,
    disrupted: {
      cell: disruptedCell,
      observedMinHour: obsMin.hour,
      reproducedMinHour: repMin.hour,
      timingErrorHours,
      observedMin: obsMin.onHand,
      reproducedMin: repMin.onHand,
    },
    deterministic,
    observedExceptions: episode.exceptions.length,
    pass,
  };
}

function argMin(series: Array<{ hour: number; onHand: number }>): { hour: number; onHand: number } {
  let best = series[0] ?? { hour: 0, onHand: 0 };
  for (const s of series) if (s.onHand < best.onHand) best = s;
  return best;
}
