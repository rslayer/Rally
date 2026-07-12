import { describe, it, expect } from "vitest";
import type { Disruption } from "@rally/domain";
import { runControlTower } from "./control-tower.js";

/** Slice 9 — the whole loop, running: ingest → estimate → detect → resolve on
 *  sensor-grounded state, over an advancing clock. */
describe("control tower (Phase 9)", () => {
  const spike: Disruption = {
    disruptionId: "CT", type: "demand_spike", facilityId: "DC_OKC", skuId: "SKU_BAR",
    startHour: 60, durationHours: 48, magnitude: 2.0, label: "resolvable", expects: "projected_stockout",
  };

  it("runs the loop and acts on a real disruption", async () => {
    const r = await runControlTower(4000, [spike]);
    expect(r.cycles.length).toBeGreaterThan(0);
    expect(r.resolved + r.escalated).toBeGreaterThan(0); // it decides, not just watches
    expect(r.caughtStockoutCells).toBeGreaterThanOrEqual(1); // catches the real risk
  });

  it("ingests fresh feeds every cycle with sane ops health", async () => {
    const r = await runControlTower(4000, [spike]);
    for (const c of r.cycles) {
      expect(c.freshFeeds).toBeGreaterThan(0);
      expect(c.estConfidence).toBeGreaterThan(0);
      expect(c.estConfidence).toBeLessThanOrEqual(1);
    }
  });

  it("attaches a rationale to every decision", async () => {
    const r = await runControlTower(4000, [spike]);
    for (const d of r.decisions) {
      expect(d.rationale.length).toBeGreaterThan(0);
      expect(["resolved", "escalated"]).toContain(d.outcome);
    }
  });

  it("is deterministic", async () => {
    const a = await runControlTower(4000, [spike]);
    const b = await runControlTower(4000, [spike]);
    expect(a.decisions).toEqual(b.decisions);
    expect(a.caughtStockoutCells).toBe(b.caughtStockoutCells);
  });
});
