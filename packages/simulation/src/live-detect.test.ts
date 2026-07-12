import { describe, it, expect } from "vitest";
import { generateDisruption, makeRng, IN_SCOPE_TYPES, TX_OK_NETWORK } from "@rally/data-gen";
import { liveDetectionFidelity, liveDetectionSweep } from "./live-detect.js";

/** Slice 7 — the same detector on ground-truth vs estimated state. Principle #5:
 *  the sensor-grounded estimate must be good enough to drive the decision. */
describe("detection on estimated state (Phase 7)", () => {
  const make = (seed: number) => {
    const rng = makeRng(seed);
    return generateDisruption(rng, `D${seed}`, { type: rng.pick(IN_SCOPE_TYPES) }, TX_OK_NETWORK);
  };
  const seeds = Array.from({ length: 12 }, (_, i) => 4000 + i);
  const sweep = liveDetectionSweep(seeds, make);

  it("catches essentially every risk ground truth sees (recall ≥ 0.9)", () => {
    expect(sweep.truthFlags).toBeGreaterThan(0);
    expect(sweep.recall).toBeGreaterThanOrEqual(0.9);
  });

  it("agrees with ground-truth detection on the vast majority of cell-ticks", () => {
    expect(sweep.agreement).toBeGreaterThanOrEqual(0.9);
  });

  it("is a conservative superset — it over-alerts rather than under-alerts", () => {
    // The safe failure direction: more flags on the estimate than on ground truth.
    expect(sweep.estFlags).toBeGreaterThanOrEqual(sweep.truthFlags);
    expect(sweep.falseNegative).toBeLessThanOrEqual(sweep.truePositive); // misses are the minority
  });

  it("produces a per-seed report with consistent bookkeeping", () => {
    const r = liveDetectionFidelity(4000, make(4000));
    expect(r.truePositive + r.falseNegative).toBe(r.truthFlags);
    expect(r.truePositive + r.falsePositive).toBe(r.estFlags);
  });
});
