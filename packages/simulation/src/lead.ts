/** Replenishment timing constants + effective-lead computation. */

import type { Network } from "@rally/domain";
import { lane } from "@rally/domain";
import { PLANT_ID } from "@rally/data-gen";

/** How often the standing (s,S) reorder policy reviews each cell. */
export const REORDER_REVIEW_HOURS = 24;
/** Fixed order-processing + loading + receiving time layered on transit. */
export const HANDLING_HOURS = 20;
export const EXPEDITE_HANDLING_FACTOR = 0.4;

/**
 * Effective replenishment lead into a DC = handling + transit. Same-region
 * transit is only a few hours, so handling is what makes a stockout physically
 * possible — and what an expedite meaningfully compresses.
 */
export function replenishLeadHours(net: Network, destId: string, expedited: boolean): number {
  const ln = lane(net, PLANT_ID, destId);
  const transit = expedited ? ln?.expeditedTransitHours ?? ln?.transitHours ?? 6 : ln?.transitHours ?? 6;
  const handling = expedited ? HANDLING_HOURS * EXPEDITE_HANDLING_FACTOR : HANDLING_HOURS;
  return Math.ceil(handling + transit);
}

/** Effective lead on an arbitrary lane (used by transfers between DCs). */
export function laneLeadHours(transitHours: number, expedited: boolean): number {
  const handling = expedited ? HANDLING_HOURS * EXPEDITE_HANDLING_FACTOR : HANDLING_HOURS;
  return Math.ceil(handling + transitHours);
}
