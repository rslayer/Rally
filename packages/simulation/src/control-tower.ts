/**
 * Slice 9 — the continuous control-tower loop.
 *
 * Every prior slice, wired into one running system. On an advancing clock, each
 * cycle:
 *   1. ingests fresh events from all live sources incrementally (orchestrator +
 *      per-source watermarks),
 *   2. re-estimates canonical state from everything seen so far,
 *   3. detects projected stockouts on that ESTIMATE, and
 *   4. runs the resolver on the estimated world — resolving or escalating each
 *      new risk with a rationale.
 *
 * This is decision-first, end to end, on sensor-grounded state: the same brain
 * from Slice 1, now driven by the real-feed eyes from Slices 2–8. The runner is
 * deterministic (clock is a parameter) and pulls in-process over a recorded
 * episode, so it needs no network.
 */

import type { Disruption } from "@rally/domain";
import { TX_OK_NETWORK, makeRng } from "@rally/data-gen";
import { IngestionOrchestrator, MemorySyncStore, type PullFn, type Source } from "@rally/importers";
import type { AnyFeedMessage } from "@rally/domain";
import { makeConfig } from "./config.js";
import { initWorld } from "./inventory-kernel.js";
import { stepSimulation } from "./step.js";
import { estimateState } from "./state-estimator.js";
import { buildEstimatedWorld, detectOnState } from "./live-detect.js";
import { resolveRisk } from "./resolver.js";
import { hourToIso } from "./time.js";

const cellK = (f: string, s: string) => `${f}|${s}`;

export interface TowerDecision {
  hour: number;
  cell: string;
  outcome: "resolved" | "escalated";
  action: string;
  rationale: string;
  confidence: number;
}

export interface TowerCycle {
  hour: number;
  freshFeeds: number;
  maxLatencyMin: number;
  estConfidence: number;
  openRisks: number;
  decisions: number;
}

export interface TowerResult {
  cycles: TowerCycle[];
  decisions: TowerDecision[];
  resolved: number;
  escalated: number;
  truthStockoutCells: number;
  caughtStockoutCells: number;
}

function windowPull(msgs: AnyFeedMessage[]): PullFn {
  return async (since, until) => {
    const lo = Date.parse(since);
    const hi = Date.parse(until);
    return msgs.filter((m) => {
      const t = Date.parse(m.emittedAt);
      return t >= lo && t <= hi;
    });
  };
}

export async function runControlTower(
  seed: number,
  disruptions: Disruption[],
  opts: { cycleHours?: number } = {},
): Promise<TowerResult> {
  const cycleHours = opts.cycleHours ?? 18;
  const config = makeConfig({ seed, disruptions, resolverEnabled: false, emitFeeds: true });

  // Ground-truth run → the feed stream to replay + the true risk cells to score.
  const gt = initWorld(config, makeRng(seed));
  for (let h = 0; h < config.horizonHours; h++) stepSimulation(gt);
  const feeds = gt.feedSink ?? [];
  const truthCells = new Set(gt.risks.map((r) => cellK(r.facilityId, r.skuId)));

  // Multi-source incremental ingestion, in-process, over the recorded feeds.
  const byType = (t: string) => feeds.filter((m) => m.feedType === t);
  const sources: Source[] = [
    { name: "telematics", pull: windowPull(byType("movement")), store: new MemorySyncStore() },
    { name: "wms", pull: windowPull(byType("warehouse")), store: new MemorySyncStore() },
    { name: "asn", pull: windowPull(byType("asn")), store: new MemorySyncStore() },
    { name: "inventory", pull: windowPull(byType("inventory_snapshot")), store: new MemorySyncStore() },
  ];
  const orch = new IngestionOrchestrator(sources, { lookbackHours: 6 });

  const cumulative: AnyFeedMessage[] = [];
  const cycles: TowerCycle[] = [];
  const decisions: TowerDecision[] = [];
  const openCells = new Set<string>();
  const everFlagged = new Set<string>();

  for (let until = cycleHours; until <= config.horizonHours; until += cycleHours) {
    const { fresh } = await orch.runCycle(hourToIso(until));
    cumulative.push(...fresh);

    const { state } = estimateState(cumulative, until, TX_OK_NETWORK);
    const world = buildEstimatedWorld(config, state, until);
    const risks = detectOnState(config, state, until);
    const flaggedNow = new Set(risks.map((r) => cellK(r.facilityId, r.skuId)));

    let cycleDecisions = 0;
    for (const risk of risks) {
      const cell = cellK(risk.facilityId, risk.skuId);
      everFlagged.add(cell);
      if (openCells.has(cell)) continue; // edge-triggered: decide once per onset
      const dec = resolveRisk(world, risk);
      decisions.push({ hour: until, cell, outcome: dec.outcome, action: dec.action, rationale: dec.rationale, confidence: dec.confidence });
      cycleDecisions++;
    }
    openCells.clear();
    for (const c of flaggedNow) openCells.add(c);

    const maxLat = fresh.reduce((m, f) => Math.max(m, f.quality.latencyMinutes), 0);
    cycles.push({
      hour: until,
      freshFeeds: fresh.length,
      maxLatencyMin: maxLat,
      estConfidence: state.overallConfidence,
      openRisks: flaggedNow.size,
      decisions: cycleDecisions,
    });
  }

  return {
    cycles,
    decisions,
    resolved: decisions.filter((d) => d.outcome === "resolved").length,
    escalated: decisions.filter((d) => d.outcome === "escalated").length,
    truthStockoutCells: truthCells.size,
    caughtStockoutCells: [...truthCells].filter((c) => everFlagged.has(c)).length,
  };
}
