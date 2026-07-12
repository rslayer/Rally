import { describe, it, expect } from "vitest";
import { buildScorecard } from "./scorer.js";

/** Slice 11 — the same oracle, resolver deciding on estimated state. The gap to
 *  the ground-truth scorecard is the cost of imperfect eyes on decisions. */
describe("estimated-path scorecard (Phase 11)", () => {
  const seeds = Array.from({ length: 8 }, (_, i) => 4000 + i);
  const gt = buildScorecard(seeds, { estimated: false });
  const est = buildScorecard(seeds, { estimated: true });

  it("still resolves some, but never out-performs the ground-truth oracle", () => {
    expect(est.scorecard.aggregateTouchlessRate).toBeGreaterThan(0);
    expect(est.scorecard.aggregateTouchlessRate).toBeLessThanOrEqual(gt.scorecard.aggregateTouchlessRate + 1e-9);
  });

  it("stays safe on the estimated path (safety recall ≥ 0.85)", () => {
    expect(est.scorecard.escalationSafetyRecall).toBeGreaterThanOrEqual(0.85);
  });

  it("scores the same number of disruptions on both paths", () => {
    // The oracle + generation are identical; only the live decision differs.
    expect(est.scorecard.disruptions).toBe(gt.scorecard.disruptions);
  });
});
