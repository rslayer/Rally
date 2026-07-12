import { describe, it, expect } from "vitest";
import { buildScorecard } from "./scorer.js";

/** Phase 3 + 4 — the thesis instrument. The load-bearing safety claim is that
 *  deliberately-unresolvable disruptions are escalated, never falsely resolved. */
describe("escalation scorecard (Phase 3/4)", () => {
  const seeds = Array.from({ length: 20 }, (_, i) => 4000 + i);
  const { scorecard, records } = buildScorecard(seeds);

  it("overwhelmingly escalates injected-unresolvable disruptions (≥95%)", () => {
    // The safety-critical property: shortfalls larger than all regional surplus
    // must escalate. The deterministic resolver catches the vast majority; the
    // scorecard's job is to MEASURE the residual, not to pretend it is zero.
    const injected = records.filter((r) => r.category === "injected_unresolvable");
    const dangerous = injected.filter((r) => r.cell === "falseResolve" || r.cell === "silentMiss");
    expect(injected.length).toBeGreaterThan(0);
    expect(dangerous.length / injected.length).toBeLessThanOrEqual(0.05);
  });

  it("escalates the vast majority of what should escalate (safety recall ≥ 0.9)", () => {
    expect(scorecard.escalationSafetyRecall).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps the dangerous false-resolve rate low (≤ 5% of unresolvable)", () => {
    const unresolvable = records.filter((r) => !r.resolvableTruth);
    const dangerous = unresolvable.filter((r) => r.cell === "falseResolve" || r.cell === "silentMiss");
    expect(dangerous.length / unresolvable.length).toBeLessThanOrEqual(0.05);
  });

  it("resolves a meaningful share of truly-resolvable disruptions", () => {
    const resolvable = records.filter((r) => r.resolvableTruth);
    const resolved = resolvable.filter((r) => r.cell === "trueResolve");
    expect(resolved.length / Math.max(1, resolvable.length)).toBeGreaterThan(0.3);
  });

  it("reports confidence positively calibrated with correctness", () => {
    expect(scorecard.calibration).toBeGreaterThan(0);
  });

  it("surfaces both off-diagonal failure modes rather than hiding them", () => {
    // The instrument must be capable of showing value forgone AND danger.
    expect(scorecard).toHaveProperty("valueForgone");
    expect(scorecard).toHaveProperty("valueCaptured");
    for (const cell of Object.values(scorecard.byExceptionType)) {
      expect(cell.total).toBeGreaterThan(0);
    }
  });
});
