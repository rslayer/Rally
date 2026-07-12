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
import { resolveRisks, resolveRisk, applyEffectToTrueWorld } from "./resolver.js";
import { emitFeedsForHour } from "./feed-emitter.js";
import { estimateState } from "./state-estimator.js";
import { buildEstimatedWorld } from "./live-detect.js";
import type { SimWorld } from "./types.js";

/** How often the estimated-decision path re-estimates + decides (poll cadence). */
const ESTIMATE_EVERY_HOURS = 3;

export function stepSimulation(world: SimWorld): void {
  world.txn = { picks: [], receipts: [], shipConfirms: [], asns: [] }; // fresh WMS/EDI log
  applyDisruptionOnset(world); // 1. disruptions land
  runProduction(world); //        2. plants complete runs
  advanceShipments(world); //     3. in-transit loads arrive
  applyDemand(world); //          4. demand draws inventory down
  closeBuckets(world); //         5. tracked orders + customer shipments
  runReplenishment(world); //     6. periodic (s,S) reorder

  if (world.config.decideOnEstimatedState) {
    // Emit this hour's feeds first, then decide on the estimate built from them.
    if (world.feedSink) emitFeedsForHour(world);
    if (world.hour % ESTIMATE_EVERY_HOURS === 0) resolveOnEstimatedState(world); // 7–8
  } else {
    const fresh = detectRisks(world); // 7. forward-project → risks/exceptions
    if (world.config.resolverEnabled) resolveRisks(world, fresh); // 8. resolve/escalate
    if (world.feedSink) emitFeedsForHour(world); // 9. shed sensor-shaped feeds
  }

  world.hour += 1; //             advance the clock
}

/**
 * Detect + resolve using state estimated from the live feeds, then replay each
 * chosen action's effect onto the TRUE world. The decision is sensor-grounded;
 * the physical outcome is real (and measured by the oracle).
 */
function resolveOnEstimatedState(world: SimWorld): void {
  const { state } = estimateState(world.feedSink ?? [], world.hour, world.config.network);
  const decisionWorld = buildEstimatedWorld(world.config, state, world.hour);
  // Share edge-trigger state + id counters so risks fire once and IDs stay unique.
  decisionWorld.seenRiskKeys = world.seenRiskKeys;
  decisionWorld.seq = world.seq;

  const fresh = detectRisks(decisionWorld); // detects on estimated positions
  for (const risk of fresh) {
    world.risks.push(risk);
    if (!world.config.resolverEnabled) continue;
    const decision = resolveRisk(decisionWorld, risk); // decide on the estimate
    world.decisions.push(decision);
    if (decision.effect) applyEffectToTrueWorld(world, decision.effect); // act on reality
    if (decision.outcome === "resolved") world.metrics.actionCost += decision.projectedCost;
  }
}
