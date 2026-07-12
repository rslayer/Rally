/**
 * stepSimulation — advance the world exactly one hour by orchestrating the
 * kernel modules in causal order, then (optionally) run the resolver on any
 * freshly-detected risk. This is the single place the closed loop is wired.
 */

import {
  applyDisruptionOnset,
  runProduction,
  advanceShipments,
  applyDemand,
  closeBuckets,
  runReplenishment,
  detectRisks,
} from "./inventory-kernel.js";
import { resolveRisks } from "./resolver.js";
import { emitFeedsForHour } from "./feed-emitter.js";
import type { SimWorld } from "./types.js";

export function stepSimulation(world: SimWorld): void {
  world.txn = { picks: [], receipts: [], shipConfirms: [] }; // fresh WMS log
  applyDisruptionOnset(world); // 1. disruptions land
  runProduction(world); //        2. plants complete runs
  advanceShipments(world); //     3. in-transit loads arrive
  applyDemand(world); //          4. demand draws inventory down
  closeBuckets(world); //         5. tracked orders + customer shipments
  runReplenishment(world); //     6. periodic (s,S) reorder
  const fresh = detectRisks(world); // 7. forward-project → risks/exceptions

  if (world.config.resolverEnabled) {
    resolveRisks(world, fresh); // 8. resolve or escalate each fresh risk
  }

  if (world.feedSink) emitFeedsForHour(world); // 9. shed sensor-shaped feeds

  world.hour += 1; //             10. advance the clock
}
