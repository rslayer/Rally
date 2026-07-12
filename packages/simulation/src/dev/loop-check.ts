/**
 * Phase 1 acceptance gate.
 *
 * With NO resolver attached, a 14-day run must:
 *   1. produce nonzero projected_stockout and order_at_risk exceptions, and
 *   2. keep every order's status consistent with ITS OWN shipment —
 *      i.e. the "22 missed shipments but 100% orders delivered" contradiction
 *      is gone.
 */

import { generateDisruption } from "@rally/data-gen";
import { makeRng } from "@rally/data-gen";
import { TX_OK_NETWORK } from "@rally/data-gen";
import { makeConfig } from "../config.js";
import { runScenario } from "../run.js";

const seed = Number(process.argv[2] ?? 42);
const rng = makeRng(seed);

// A heat-wave demand spike + a late inbound — enough to bite through cover.
const disruptions = [
  generateDisruption(rng, "D1", { type: "demand_spike", startMin: 36, startMax: 60 }, TX_OK_NETWORK),
  generateDisruption(rng, "D2", { type: "inbound_delay", startMin: 60, startMax: 120 }, TX_OK_NETWORK),
];

const config = makeConfig({ seed, disruptions, resolverEnabled: false, horizonHours: 14 * 24 });
const result = runScenario(config);

const projected = result.exceptions.filter((e) => e.type === "projected_stockout").length;
const atRisk = result.exceptions.filter((e) => e.type === "order_at_risk").length;

// Invariant: an order is delivered iff its own shipment delivered it in full.
let inconsistent = 0;
const shipById = new Map(result.finalState.shipments.map((s) => [s.shipmentId, s]));
for (const o of result.finalState.orders) {
  const ship = o.allocatedShipmentId ? shipById.get(o.allocatedShipmentId) : undefined;
  const deliveredByOwnShipment =
    !!ship && ship.status === "delivered" && ship.orderId === o.orderId && o.backorderedUnits === 0;
  if (o.status === "delivered" && !deliveredByOwnShipment) inconsistent++;
  if (o.status !== "delivered" && deliveredByOwnShipment) inconsistent++;
}

const delivered = result.finalState.orders.filter((o) => o.status === "delivered").length;
const missedShipments = result.metrics.shipmentsMissed;

console.log("── Phase 1 · close the loop ──────────────────────────────");
console.log(`seed                     ${seed}`);
console.log(`disruptions              ${disruptions.map((d) => `${d.type}@${d.facilityId}/${d.skuId}`).join(", ")}`);
console.log(`orders created           ${result.metrics.ordersCreated}`);
console.log(`orders delivered         ${delivered}`);
console.log(`orders backordered       ${result.metrics.ordersBackordered}`);
console.log(`missed customer shipments${String(missedShipments).padStart(6)}`);
console.log(`projected_stockout excs  ${projected}`);
console.log(`order_at_risk excs       ${atRisk}`);
console.log(`unmet demand units       ${Math.round(result.metrics.unmetUnits)}`);
console.log(`stockout-hours           ${result.metrics.stockoutHours}`);
console.log(`order↔shipment mismatches${String(inconsistent).padStart(6)}`);

const pass = projected > 0 && atRisk > 0 && inconsistent === 0;
console.log("──────────────────────────────────────────────────────────");
console.log(pass ? "GATE PASS ✅" : "GATE FAIL ❌");
process.exit(pass ? 0 : 1);
