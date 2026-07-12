/** Exceptions surfaced by the closed loop before any resolver runs. */

export type ExceptionType = "projected_stockout" | "order_at_risk";

export interface Exception {
  exceptionId: string;
  type: ExceptionType;
  hour: number; // sim hour it was detected
  facilityId?: string;
  skuId?: string;
  orderId?: string;
  detail: string;
  confidence: number;
}
