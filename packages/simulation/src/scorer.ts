/**
 * Part C — the escalation scoring harness. This is the thesis instrument.
 *
 * The question is not "what fraction did the system resolve" but "does the
 * system resolve what it should and escalate what it must." We answer it with a
 * confusion matrix, not a single number.
 *
 * Oracle. The world is closed, so we can know the truth. For every disruption we
 * run:
 *   • a `hold` counterfactual (resolver off) — establishes the real service miss;
 *   • one forced-action counterfactual per constructive action — establishes,
 *     independently of what the resolver chose, whether ANY in-set action
 *     actually recovers service within policy → the ground-truth resolvable label;
 *   • the live resolver run — the decision under test.
 *
 * The label comes from executed counterfactuals, not from the resolver's own
 * projection, so we never grade our own homework. False Resolve — the resolver
 * claimed a fix but service was still missed — is weighted as the dangerous cell.
 */

import type { ResolutionAction, ThesisScorecard, ConfusionCell } from "@rally/domain";
import { makeRng, generateDisruption, IN_SCOPE_TYPES, HELD_OUT_TYPES, TX_OK_NETWORK } from "@rally/data-gen";
import type { Disruption } from "@rally/domain";
import { makeConfig } from "./config.js";
import { runScenario } from "./run.js";

const MIN_MISS_UNITS = 40; // below this the disruption never caused a real miss
const RECOVERY_FRAC = 0.1; // "recovers service" = miss cut to ≤10% of hold
const CONSTRUCTIVE: ResolutionAction[] = [
  "transfer_inventory",
  "expedite_inbound",
  "pull_forward_production",
];

export type Category = "in_scope" | "injected_unresolvable" | "held_out";
export type CellClass =
  | "trueResolve"
  | "falseResolve"
  | "falseEscalate"
  | "trueEscalate"
  | "silentMiss";

export interface ScenarioRecord {
  disruptionId: string;
  type: string;
  category: Category;
  resolvableTruth: boolean;
  holdUnmet: number;
  liveUnmet: number;
  bestForcedUnmet: number;
  agent: "resolved" | "escalated" | "silent";
  action?: ResolutionAction;
  rationale: string;
  confidence: number;
  cell: CellClass;
  serviceSaved: number;
  recoverableForgone: number;
  actionCost: number;
}

export interface ScorecardResult {
  scorecard: ThesisScorecard;
  records: ScenarioRecord[];
  silentMiss: number;
  dangerous: number; // falseResolve + silentMiss
}

/** Six scenarios per seed: 3 in-scope, 1 injected-unresolvable, 2 held-out. */
export function generateScenarioSet(seed: number): Array<{ disruption: Disruption; category: Category }> {
  const rng = makeRng(seed);
  const net = TX_OK_NETWORK;
  const out: Array<{ disruption: Disruption; category: Category }> = [];
  for (const type of IN_SCOPE_TYPES) {
    out.push({ disruption: generateDisruption(rng, `${seed}-${type}`, { type }, net), category: "in_scope" });
  }
  out.push({
    disruption: generateDisruption(rng, `${seed}-injected`, { type: "demand_spike", injectedUnresolvable: true }, net),
    category: "injected_unresolvable",
  });
  for (const type of HELD_OUT_TYPES) {
    out.push({ disruption: generateDisruption(rng, `${seed}-${type}`, { type }, net), category: "held_out" });
  }
  return out;
}

function unmet(seed: number, d: Disruption, opts: { resolverEnabled: boolean; forceAction?: ResolutionAction; decideOnEstimatedState?: boolean }) {
  return runScenario(makeConfig({ seed, disruptions: [d], ...opts }));
}

export function scoreScenario(seed: number, d: Disruption, category: Category, opts: { estimated?: boolean } = {}): ScenarioRecord | null {
  const hold = unmet(seed, d, { resolverEnabled: false });
  const holdUnmet = Math.round(hold.metrics.unmetUnits);
  if (holdUnmet < MIN_MISS_UNITS) return null; // benign — never a real exception

  // Oracle: independently test whether ANY constructive action recovers service.
  let bestForcedUnmet = holdUnmet;
  for (const action of CONSTRUCTIVE) {
    const r = unmet(seed, d, { resolverEnabled: true, forceAction: action });
    bestForcedUnmet = Math.min(bestForcedUnmet, Math.round(r.metrics.unmetUnits));
  }
  const resolvableTruth = bestForcedUnmet <= Math.max(1, holdUnmet * RECOVERY_FRAC);

  // The decision under test — on ground-truth state, or (Slice 11) on the state
  // estimated from the live feeds with effects replayed onto the true world.
  const live = unmet(seed, d, { resolverEnabled: true, ...(opts.estimated ? { decideOnEstimatedState: true } : {}) });
  const liveUnmet = Math.round(live.metrics.unmetUnits);
  const riskById = new Map(live.risks.map((r) => [r.riskId, r]));
  // A disruption re-fires as it grows; judge the system by how it handled the
  // MOST SEVERE manifestation, not by an early decision on the leading edge.
  const cellDecisions = live.decisions
    .map((dec) => ({ dec, risk: riskById.get(dec.riskId) }))
    .filter((x) => x.risk && x.risk.facilityId === d.facilityId && x.risk.skuId === d.skuId)
    .sort((a, b) => (b.risk!.projectedShortfallUnits) - (a.risk!.projectedShortfallUnits));
  const definitive = cellDecisions[0]?.dec;

  let agent: ScenarioRecord["agent"];
  let confidence: number;
  let rationale: string;
  let action: ResolutionAction | undefined;
  if (definitive?.outcome === "resolved") {
    agent = "resolved";
    confidence = definitive.confidence;
    rationale = definitive.rationale;
    action = definitive.action;
  } else if (definitive?.outcome === "escalated") {
    agent = "escalated";
    confidence = definitive.confidence;
    rationale = definitive.rationale;
  } else {
    agent = "silent";
    confidence = 0.5;
    rationale = "no material risk detected — undetected service miss";
  }

  let cell: CellClass;
  if (agent === "resolved") {
    const protectedService = liveUnmet <= Math.max(1, holdUnmet * RECOVERY_FRAC);
    cell = protectedService ? "trueResolve" : "falseResolve";
  } else if (agent === "escalated") {
    cell = resolvableTruth ? "falseEscalate" : "trueEscalate";
  } else {
    cell = "silentMiss";
  }

  const serviceSaved = Math.max(0, holdUnmet - liveUnmet);
  const recoverableForgone = cell === "falseEscalate" ? Math.max(0, holdUnmet - bestForcedUnmet) : 0;

  return {
    disruptionId: d.disruptionId,
    type: d.type,
    category,
    resolvableTruth,
    holdUnmet,
    liveUnmet,
    bestForcedUnmet,
    agent,
    ...(action ? { action } : {}),
    rationale,
    confidence,
    cell,
    serviceSaved,
    recoverableForgone,
    actionCost: Math.round(live.metrics.actionCost),
  };
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return Number((sxy / Math.sqrt(sxx * syy)).toFixed(3));
}

function emptyCell(): ConfusionCell & { silentMiss: number } {
  return { touchlessResolutionRate: 0, trueResolve: 0, trueEscalate: 0, falseEscalate: 0, falseResolve: 0, total: 0, silentMiss: 0 };
}

export function buildScorecard(seeds: number[], opts: { estimated?: boolean } = {}): ScorecardResult {
  const records: ScenarioRecord[] = [];
  for (const seed of seeds) {
    for (const { disruption, category } of generateScenarioSet(seed)) {
      const rec = scoreScenario(seed, disruption, category, opts);
      if (rec) records.push(rec);
    }
  }

  const byType: Record<string, ConfusionCell> = {};
  const byTypeTmp: Record<string, ConfusionCell & { silentMiss: number }> = {};
  for (const r of records) {
    const c = (byTypeTmp[r.type] ??= emptyCell());
    c.total++;
    if (r.cell === "trueResolve") c.trueResolve++;
    else if (r.cell === "trueEscalate") c.trueEscalate++;
    else if (r.cell === "falseEscalate") c.falseEscalate++;
    else if (r.cell === "falseResolve") c.falseResolve++;
    else if (r.cell === "silentMiss") {
      c.silentMiss++;
      c.falseResolve++; // operationally identical danger: miss, no human warned
    }
  }
  for (const [t, c] of Object.entries(byTypeTmp)) {
    c.touchlessResolutionRate = c.total ? Number((c.trueResolve / c.total).toFixed(3)) : 0;
    const { silentMiss, ...cell } = c;
    void silentMiss;
    byType[t] = cell;
  }

  const shouldEscalate = records.filter((r) => !r.resolvableTruth);
  const escalatedWhenShould = shouldEscalate.filter((r) => r.agent === "escalated");
  const allEscalations = records.filter((r) => r.agent === "escalated");
  const neededEscalations = allEscalations.filter((r) => !r.resolvableTruth);

  const trueResolves = records.filter((r) => r.cell === "trueResolve");
  const falseEscalates = records.filter((r) => r.cell === "falseEscalate");
  const decided = records.filter((r) => r.agent !== "silent");
  const calibration = pearson(
    decided.map((r) => r.confidence),
    decided.map((r) => (r.cell === "trueResolve" || r.cell === "trueEscalate" ? 1 : 0)),
  );

  const silentMiss = records.filter((r) => r.cell === "silentMiss").length;
  const falseResolve = records.filter((r) => r.cell === "falseResolve").length;

  const scorecard: ThesisScorecard = {
    seeds,
    disruptions: records.length,
    byExceptionType: byType,
    escalationSafetyRecall: shouldEscalate.length ? Number((escalatedWhenShould.length / shouldEscalate.length).toFixed(3)) : 1,
    escalationPrecision: allEscalations.length ? Number((neededEscalations.length / allEscalations.length).toFixed(3)) : 1,
    valueCaptured: Math.round(trueResolves.reduce((a, r) => a + r.serviceSaved, 0)),
    valueForgone: Math.round(falseEscalates.reduce((a, r) => a + r.recoverableForgone, 0)),
    calibration,
    aggregateTouchlessRate: records.length ? Number((trueResolves.length / records.length).toFixed(3)) : 0,
  };

  return { scorecard, records, silentMiss, dangerous: falseResolve + silentMiss };
}
