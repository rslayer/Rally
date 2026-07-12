/**
 * Seeded, stochastic disruption generator. Every disruption is drawn from a
 * distribution over type, timing, severity, and location — never hand-placed —
 * and carries a ground-truth resolvable/unresolvable label. The scorer's oracle
 * independently verifies the label so we never grade our own homework.
 */

import type { Disruption, DisruptionType, Network } from "@rally/domain";
import type { Rng } from "./rng.js";
import { DC_IDS } from "./network.js";

export const IN_SCOPE_TYPES: DisruptionType[] = ["demand_spike", "inbound_delay", "supply_shortfall"];
export const HELD_OUT_TYPES: DisruptionType[] = ["labor_action", "quality_hold"];

export interface DisruptionSpec {
  type: DisruptionType;
  /** Force an unrecoverable magnitude (False-Resolve probe). */
  injectedUnresolvable?: boolean;
  startMin?: number;
  startMax?: number;
}

export function generateDisruption(
  rng: Rng,
  id: string,
  spec: DisruptionSpec,
  net: Network,
): Disruption {
  const facilityId = rng.pick(DC_IDS);
  const skuId = rng.pick(net.skus).skuId;
  const startHour = rng.int(spec.startMin ?? 24, spec.startMax ?? 120);
  const outOfScope = HELD_OUT_TYPES.includes(spec.type);
  const injected = spec.injectedUnresolvable ?? false;

  let durationHours = 24;
  let magnitude = 1;

  switch (spec.type) {
    case "demand_spike":
      durationHours = rng.int(24, 72);
      // Resolvable spikes are coverable by transfer/expedite; injected ones are
      // deliberately larger than all regional surplus combined.
      magnitude = injected ? rng.float(6, 10) : rng.float(1.9, 3.0);
      break;
    case "inbound_delay":
      durationHours = rng.int(18, 48);
      magnitude = durationHours; // delay hours
      break;
    case "supply_shortfall":
      durationHours = rng.int(24, 48);
      magnitude = rng.float(0.5, 0.85); // fraction of the run cut
      break;
    case "labor_action":
      durationHours = rng.int(24, 60); // dock down — no in-set action fixes it
      magnitude = 1;
      break;
    case "quality_hold":
      durationHours = rng.int(24, 72); // SKU quarantined network-wide
      magnitude = 1;
      break;
  }

  // Label by construction; the oracle verifies.
  const label = outOfScope || injected ? "unresolvable" : "resolvable";

  return {
    disruptionId: id,
    type: spec.type,
    facilityId,
    skuId,
    startHour,
    durationHours,
    magnitude,
    label,
    expects: spec.type === "inbound_delay" || spec.type === "supply_shortfall" || spec.type === "demand_spike"
      ? "projected_stockout"
      : "projected_stockout",
    ...(injected ? { injectedUnresolvable: true } : {}),
    ...(outOfScope ? { outOfScope: true } : {}),
  };
}
