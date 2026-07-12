/** runScenario — drive a full closed-loop run and collect results. */

import type { ScenarioState } from "@rally/domain";
import { makeRng } from "@rally/data-gen";
import { initWorld, snapshot } from "./inventory-kernel.js";
import { stepSimulation } from "./step.js";
import type { RunResult, SimConfig } from "./types.js";

export function runScenario(config: SimConfig): RunResult {
  const rng = makeRng(config.seed);
  const world = initWorld(config, rng);
  const timeline: ScenarioState[] = [snapshot(world)];

  for (let h = 0; h < config.horizonHours; h++) {
    stepSimulation(world);
    if (world.hour % 24 === 0) timeline.push(snapshot(world));
  }

  const finalState = snapshot(world);
  return {
    config,
    finalState,
    timeline,
    exceptions: world.exceptions,
    risks: world.risks,
    decisions: world.decisions,
    metrics: world.metrics,
    ...(world.feedSink ? { feeds: world.feedSink } : {}),
  };
}
