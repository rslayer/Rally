/** Prediction and resolution types — Part B. */

export interface StockoutRisk {
  riskId: string;
  facilityId: string;
  skuId: string;
  detectedAtHour: number;
  hoursToStockout: number; // from forward projection
  projectedShortfallUnits: number;
  confidence: number; // inherits estimator confidence
  drivers: string[]; // e.g. "heat-wave demand +45%", "late inbound ship-0142"
}

export type ResolutionAction =
  | "transfer_inventory" // pull from an alternate DC with surplus
  | "pull_forward_production" // advance a scheduled production run
  | "expedite_inbound" // upgrade an in-transit replenishment
  | "partial_ship_backorder" // protect the priority fraction, backorder the rest
  | "hold" // no action; monitor
  | "escalate"; // hand to a human

export type ResolutionOutcome = "resolved" | "escalated";

/** Guardrail evaluation — reused cost caps / approval thresholds. */
export interface PolicyResult {
  allowed: boolean;
  reason: string;
}

export interface ResolutionDecision {
  riskId: string;
  action: ResolutionAction;
  rationale: string;
  projectedServiceRecovery: number; // fraction of shortfall recovered, 0..1
  projectedCost: number;
  confidence: number;
  policyResult: PolicyResult;
  outcome: ResolutionOutcome;
  /** Concrete state mutation the action applied, for audit + counterfactual. */
  effect?: ResolutionEffect;
}

/** The state mutation a chosen action commits. Without this there is no proof. */
export type ResolutionEffect =
  | {
      kind: "transfer_inventory";
      fromFacilityId: string;
      toFacilityId: string;
      skuId: string;
      units: number;
      shipmentId: string;
    }
  | {
      kind: "pull_forward_production";
      runId: string;
      fromHour: number;
      toHour: number;
    }
  | {
      kind: "expedite_inbound";
      shipmentId: string;
      oldEtaHour: number;
      newEtaHour: number;
    }
  | {
      kind: "partial_ship_backorder";
      orderId: string;
      shippedUnits: number;
      backorderedUnits: number;
    };

/** Policy guardrail configuration. */
export interface PolicyConfig {
  /** Max cost a single autonomous action may commit before requiring approval. */
  maxAutonomousCost: number;
  /** Minimum resolver confidence to act autonomously. */
  minConfidence: number;
  /** Minimum projected service recovery to count an action as a resolution. */
  minServiceRecovery: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  maxAutonomousCost: 25_000,
  minConfidence: 0.6,
  minServiceRecovery: 0.999, // a resolution must fully protect service
};
