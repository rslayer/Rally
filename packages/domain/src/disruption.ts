/**
 * Disruptions are the unit the escalation scorecard grades. Each is stochastic,
 * reproducible by seed, and carries a ground-truth resolvability label.
 */

import type { DisruptionLabel } from "./scorecard.js";
import type { ExceptionType } from "./exceptions.js";

export type DisruptionType =
  | "demand_spike" // heat-wave style pull surge at a DC/SKU
  | "inbound_delay" // an in-transit replenishment is delayed
  | "supply_shortfall" // a production run is cut or cancelled
  // held-out / out-of-scope types — correct behavior is to escalate:
  | "labor_action" // facility throughput collapses (no in-set action fixes it)
  | "quality_hold"; // a SKU is quarantined network-wide

export interface Disruption {
  disruptionId: string;
  type: DisruptionType;
  facilityId: string;
  skuId: string;
  startHour: number;
  durationHours: number;
  /** Type-specific magnitude: demand multiplier, delay hours, or cut fraction. */
  magnitude: number;
  /** Which shipment/run it perturbs, when applicable. Resolved at apply time. */
  targetRef?: string;
  /** Ground-truth label, set by construction and verified by the oracle. */
  label: DisruptionLabel;
  /** The exception type this disruption is expected to surface. */
  expects: ExceptionType;
  /** True when injected specifically to be unrecoverable (False-Resolve probe). */
  injectedUnresolvable?: boolean;
  /** True when the type is outside the resolver's designed scope. */
  outOfScope?: boolean;
}
