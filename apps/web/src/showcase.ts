/** Builds the data behind the three dashboard panels. */

import {
  makeConfig,
  initWorld,
  stepSimulation,
  estimateState,
  buildScorecard,
  generateScenarioSet,
} from "@rally/simulation";
import type { ScenarioRecord } from "@rally/simulation";
import { TX_OK_NETWORK, makeRng } from "@rally/data-gen";

export interface DecisionRow {
  type: string;
  category: string;
  outcome: "resolved" | "escalated" | "silent";
  correct: boolean;
  cell: string;
  action: string;
  rationale: string;
  confidence: number;
  holdUnmet: number;
  serviceSaved: number;
}

export interface Showcase {
  region: string;
  atHour: number;
  estimated: ReturnType<typeof estimateState>["state"];
  drift: ReturnType<typeof estimateState>["drift"];
  feedCount: number;
  decisions: DecisionRow[];
  scorecard: ReturnType<typeof buildScorecard>["scorecard"];
  records: ScenarioRecord[];
}

const CELL_LABEL: Record<string, string> = {
  trueResolve: "resolved · value captured",
  trueEscalate: "escalated · correct handoff",
  falseEscalate: "escalated · over-caution",
  falseResolve: "resolved · STILL MISSED",
  silentMiss: "undetected · silent miss",
};

/** A representative, honest sample of graded decisions for the queue: real
 *  resolves and escalations, plus any surfaced failure modes. */
function decisionSample(records: ScenarioRecord[]): DecisionRow[] {
  const order = ["trueResolve", "trueEscalate", "falseEscalate", "falseResolve", "silentMiss"];
  const rows: DecisionRow[] = [];
  const perCellCap = 3;
  for (const cell of order) {
    let taken = 0;
    for (const r of records) {
      if (r.cell !== cell || taken >= perCellCap) continue;
      taken++;
      rows.push({
        type: r.type,
        category: r.category,
        outcome: r.agent,
        correct: r.cell === "trueResolve" || r.cell === "trueEscalate",
        cell: CELL_LABEL[r.cell] ?? r.cell,
        action: r.action ?? "—",
        rationale: r.rationale,
        confidence: r.confidence,
        holdUnmet: r.holdUnmet,
        serviceSaved: r.serviceSaved,
      });
    }
  }
  return rows;
}

export function buildShowcase(seed = 4000, scorecardSeeds = 12): Showcase {
  const seeds = Array.from({ length: scorecardSeeds }, (_, i) => 4000 + i);
  const { scorecard, records } = buildScorecard(seeds);

  // State layer: a representative run WITH feeds, so track-and-trace reads from
  // ESTIMATED (not ground-truth) state and shows resolver actions in transit.
  const focus = generateScenarioSet(seed)[0]!.disruption; // an in-scope demand spike
  const fcfg = makeConfig({ seed, disruptions: [focus], resolverEnabled: true, emitFeeds: true });
  const world = initWorld(fcfg, makeRng(seed));
  const atHour = focus.startHour + 30;
  for (let h = 0; h < fcfg.horizonHours; h++) stepSimulation(world);
  const { state: estimated, drift } = estimateState(world.feedSink ?? [], atHour, TX_OK_NETWORK);

  return {
    region: TX_OK_NETWORK.region,
    atHour,
    estimated,
    drift,
    feedCount: world.feedSink?.length ?? 0,
    decisions: decisionSample(records),
    scorecard,
    records,
  };
}
