import { describe, it, expect } from "vitest";
import { EPISODE_DISRUPTION, EPISODE_SEED } from "@rally/data-gen";
import { recordEpisode, backtest } from "./backtest.js";

/** Phase 5 — backtest: replay an observed episode through the real-feed adapter
 *  and confirm the simulator reproduces the observed physical outcome. */
describe("backtest (Phase 5)", () => {
  const episode = recordEpisode(EPISODE_SEED, EPISODE_DISRUPTION);

  it("reproduces observed state from vendor-round-tripped feeds within tolerance", () => {
    const r = backtest(episode, true);
    expect(r.stateMeanRelErr).toBeLessThan(0.03);
    expect(r.stateMaxRelErr).toBeLessThan(0.15);
  });

  it("reproduces the disrupted-cell stockout at the right time", () => {
    const r = backtest(episode, true);
    expect(r.disrupted.timingErrorHours).toBeLessThanOrEqual(12);
    expect(r.pass).toBe(true);
  });

  it("replays deterministically", () => {
    const a = recordEpisode(EPISODE_SEED, EPISODE_DISRUPTION);
    const b = recordEpisode(EPISODE_SEED, EPISODE_DISRUPTION);
    expect(a.stockoutHours).toBe(b.stockoutHours);
    expect(a.exceptions.length).toBe(b.exceptions.length);
  });

  it("records a real disruption (nonzero stockout-hours + exceptions)", () => {
    expect(episode.stockoutHours).toBeGreaterThan(0);
    expect(episode.exceptions.length).toBeGreaterThan(0);
  });
});
