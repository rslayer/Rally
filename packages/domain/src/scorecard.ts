/** Part C — Escalation scoring harness types. */

/** Ground-truth label the generator stamps on every disruption. */
export type DisruptionLabel = "resolvable" | "unresolvable";

/** One cell-worth of the 2×2, per exception type. */
export interface ConfusionCell {
  touchlessResolutionRate: number; // trueResolve / total
  trueResolve: number; // resolvable   & resolved  → value captured
  trueEscalate: number; // unresolvable & escalated → correct handoff
  falseEscalate: number; // resolvable   & escalated → value forgone
  falseResolve: number; // unresolvable & resolved  → DANGEROUS silent failure
  total: number;
}

export interface ThesisScorecard {
  seeds: number[];
  disruptions: number;
  byExceptionType: Record<string, ConfusionCell>;
  /** Of all that SHOULD escalate, fraction escalated. Safety-critical. */
  escalationSafetyRecall: number;
  /** Of all escalations, fraction that needed it. */
  escalationPrecision: number;
  /** Service+cost value recovered on True Resolves. */
  valueCaptured: number;
  /** Recoverable value lost on False Escalates. */
  valueForgone: number;
  /** Correlation of confidence with correctness (−1..1). */
  calibration: number;
  /** The honest aggregate "where 95 lands" number. */
  aggregateTouchlessRate: number;
}
