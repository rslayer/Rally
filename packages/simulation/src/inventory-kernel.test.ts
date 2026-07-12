import { describe, it, expect } from "vitest";
import { makeRng, generateDisruption, TX_OK_NETWORK } from "@rally/data-gen";
import { makeConfig } from "./config.js";
import { runScenario } from "./run.js";

/** Phase 1 — the loop must close and stay self-consistent. */
describe("closed loop (Phase 1)", () => {
  const seeds = [42, 7, 100, 2026, 5];

  it("produces both exception types under a disruption, with no resolver", () => {
    let sawProjected = false;
    let sawAtRisk = false;
    for (const seed of seeds) {
      const rng = makeRng(seed);
      const disruptions = [
        generateDisruption(rng, "A", { type: "demand_spike", startMin: 36, startMax: 60 }, TX_OK_NETWORK),
        generateDisruption(rng, "B", { type: "inbound_delay", startMin: 60, startMax: 120 }, TX_OK_NETWORK),
      ];
      const r = runScenario(makeConfig({ seed, disruptions, resolverEnabled: false }));
      if (r.exceptions.some((e) => e.type === "projected_stockout")) sawProjected = true;
      if (r.exceptions.some((e) => e.type === "order_at_risk")) sawAtRisk = true;
    }
    expect(sawProjected).toBe(true);
    expect(sawAtRisk).toBe(true);
  });

  it("keeps every order consistent with ITS OWN shipment (no phantom deliveries)", () => {
    const rng = makeRng(42);
    const disruptions = [generateDisruption(rng, "A", { type: "demand_spike", startMin: 36, startMax: 60 }, TX_OK_NETWORK)];
    const r = runScenario(makeConfig({ seed: 42, disruptions, resolverEnabled: false }));
    const shipById = new Map(r.finalState.shipments.map((s) => [s.shipmentId, s]));
    for (const o of r.finalState.orders) {
      const ship = o.allocatedShipmentId ? shipById.get(o.allocatedShipmentId) : undefined;
      const deliveredByOwn = !!ship && ship.status === "delivered" && ship.orderId === o.orderId && o.backorderedUnits === 0;
      // An order is delivered iff its own shipment delivered it in full.
      if (o.status === "delivered") expect(deliveredByOwn).toBe(true);
    }
  });

  it("is reproducible by seed", () => {
    const cfg = () => makeConfig({ seed: 99, disruptions: [], resolverEnabled: false });
    const a = runScenario(cfg());
    const b = runScenario(cfg());
    expect(a.metrics).toEqual(b.metrics);
  });
});
