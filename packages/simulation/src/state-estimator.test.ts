import { describe, it, expect } from "vitest";
import type { AnyFeedMessage, ScenarioState } from "@rally/domain";
import { makeRng, generateDisruption, TX_OK_NETWORK } from "@rally/data-gen";
import { makeConfig } from "./config.js";
import { initWorld, snapshot } from "./inventory-kernel.js";
import { stepSimulation } from "./step.js";
import { estimateState } from "./state-estimator.js";

/** Phase 2 — state rebuilt from feeds matches ground truth within tolerance,
 *  including at hours between the lagging inventory snapshots. */
describe("state estimator (Phase 2)", () => {
  it("reconstructs on-hand within tolerance at non-snapshot hours", () => {
    const seed = 42;
    const rng = makeRng(seed);
    const disruptions = [
      generateDisruption(rng, "A", { type: "demand_spike", startMin: 36, startMax: 72 }, TX_OK_NETWORK),
      generateDisruption(rng, "B", { type: "supply_shortfall", startMin: 80, startMax: 140 }, TX_OK_NETWORK),
    ];
    const config = makeConfig({ seed, disruptions, resolverEnabled: false, emitFeeds: true });
    const world = initWorld(config, makeRng(seed));
    const probeHours = [5, 17, 29, 77, 149, 233, 331]; // deliberately off the 12h snapshot grid
    const truthAt = new Map<number, ScenarioState>();
    for (let h = 0; h < config.horizonHours; h++) {
      stepSimulation(world);
      // Feeds are labeled by the processed hour (world.hour - 1); match it.
      if (probeHours.includes(world.hour - 1)) truthAt.set(world.hour - 1, snapshot(world));
    }
    const feeds: AnyFeedMessage[] = world.feedSink ?? [];

    let sum = 0;
    let n = 0;
    let max = 0;
    for (const h of probeHours) {
      const truth = truthAt.get(h)!;
      const { state } = estimateState(feeds, h, TX_OK_NETWORK);
      for (const t of truth.positions) {
        const e = state.positions.find((p) => p.facilityId === t.facilityId && p.skuId === t.skuId);
        const rel = Math.abs((e?.onHandUnits ?? 0) - t.onHandUnits) / Math.max(50, t.onHandUnits);
        sum += rel;
        n++;
        max = Math.max(max, rel);
      }
    }
    expect(sum / n).toBeLessThan(0.03); // mean rel error < 3%
    expect(max).toBeLessThan(0.15); // max rel error < 15%
  });

  it("attaches confidence < 1 to estimated state (it is an estimate)", () => {
    const seed = 3;
    const config = makeConfig({ seed, disruptions: [], resolverEnabled: false, emitFeeds: true });
    const world = initWorld(config, makeRng(seed));
    for (let h = 0; h < 200; h++) stepSimulation(world);
    const { state } = estimateState(world.feedSink ?? [], 150, TX_OK_NETWORK);
    expect(state.overallConfidence).toBeGreaterThan(0);
    expect(state.overallConfidence).toBeLessThanOrEqual(1);
    for (const p of state.positions) expect(p.confidence).toBeLessThanOrEqual(1);
  });
});
