import { describe, it, expect } from "vitest";
import { generateScenarioSet, scoreScenario } from "./scorer.js";
import { estimateState, makeConfig, initWorld, snapshot } from "./index.js";
import { stepSimulation } from "./step.js";
import { makeRng, TX_OK_NETWORK } from "@rally/data-gen";
import type { Disruption } from "@rally/domain";

/** Slice 12 — labor/quality holds become an observable feed; on the estimated
 *  path the resolver escalates them from sensed status, not privileged config. */
describe("operational-status feed (Phase 12)", () => {
  it("surfaces a labor stoppage into estimated opsHolds", () => {
    const labor: Disruption = { disruptionId: "L", type: "labor_action", facilityId: "DC_HOU", skuId: "SKU_COLA", startHour: 48, durationHours: 60, magnitude: 1, label: "unresolvable", expects: "order_at_risk", outOfScope: true };
    const config = makeConfig({ seed: 5, disruptions: [labor], resolverEnabled: false, emitFeeds: true });
    const world = initWorld(config, makeRng(5));
    for (let h = 0; h < 90; h++) stepSimulation(world);
    const { state } = estimateState(world.feedSink ?? [], 80, TX_OK_NETWORK);
    expect(state.opsHolds.suspendedFacilities).toContain("DC_HOU");
  });

  it("escalates every held-out disruption on the estimated path via the feed", () => {
    const seeds = Array.from({ length: 8 }, (_, i) => 4000 + i);
    let total = 0, escalated = 0, dangerous = 0;
    for (const seed of seeds) {
      for (const { disruption, category } of generateScenarioSet(seed)) {
        if (category !== "held_out") continue;
        const r = scoreScenario(seed, disruption, category, { estimated: true });
        if (!r) continue;
        total++;
        if (r.cell === "trueEscalate") escalated++;
        if (r.cell === "falseResolve" || r.cell === "silentMiss") dangerous++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(dangerous).toBe(0);
    expect(escalated / total).toBeGreaterThanOrEqual(0.9);
  });

  it("ground-truth snapshot also carries observable holds", () => {
    const labor: Disruption = { disruptionId: "L", type: "labor_action", facilityId: "DC_SAT", skuId: "SKU_BAR", startHour: 24, durationHours: 60, magnitude: 1, label: "unresolvable", expects: "order_at_risk", outOfScope: true };
    const world = initWorld(makeConfig({ seed: 1, disruptions: [labor], resolverEnabled: false }), makeRng(1));
    for (let h = 0; h < 40; h++) stepSimulation(world);
    expect(snapshot(world).opsHolds.suspendedFacilities).toContain("DC_SAT");
  });
});
