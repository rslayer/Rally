/** Disruption effects that are continuous (read every tick + during projection). */

import type { Disruption } from "@rally/domain";

export function isActive(d: Disruption, hour: number): boolean {
  return hour >= d.startHour && hour < d.startHour + d.durationHours;
}

export function activeDisruptions(disruptions: Disruption[], hour: number): Disruption[] {
  return disruptions.filter((d) => isActive(d, hour));
}

/**
 * Forecastable demand multiplier for a cell at an hour. demand_spike is the only
 * disruption that shows up as demand (a heat wave is forecastable, so projection
 * sees it too). Product of all active spikes on this cell.
 */
export function demandMultiplier(
  disruptions: Disruption[],
  facilityId: string,
  skuId: string,
  hour: number,
): number {
  let m = 1;
  for (const d of disruptions) {
    if (
      d.type === "demand_spike" &&
      d.facilityId === facilityId &&
      d.skuId === skuId &&
      isActive(d, hour)
    ) {
      m *= d.magnitude;
    }
  }
  return m;
}

/** A DC whose dock is down (labor action) can neither receive nor ship. */
export function facilityFrozen(
  disruptions: Disruption[],
  facilityId: string,
  hour: number,
): boolean {
  return disruptions.some(
    (d) => d.type === "labor_action" && d.facilityId === facilityId && isActive(d, hour),
  );
}

/** A SKU under quality hold is quarantined network-wide — unusable, immovable. */
export function skuQualityHeld(disruptions: Disruption[], skuId: string, hour: number): boolean {
  return disruptions.some(
    (d) => d.type === "quality_hold" && d.skuId === skuId && isActive(d, hour),
  );
}

/**
 * Observable operational holds that put a risk outside the resolver's designed
 * scope: a suspended dock or a quarantined SKU. These are known states (a strike
 * or a recall is visible), so the resolver is expected to recognize and escalate
 * them rather than commit an action that cannot physically land.
 */
export function outOfScopeHold(
  disruptions: Disruption[],
  facilityId: string,
  skuId: string,
  hour: number,
  windowHours: number,
): { held: boolean; reason: string } {
  // Symmetric window: a facility mid-strike OR recently recovering from one is
  // still out of scope — the miss it caused cannot be un-missed by a late action.
  for (let h = hour - windowHours; h <= hour + windowHours; h += 6) {
    if (facilityFrozen(disruptions, facilityId, h))
      return { held: true, reason: `receiving suspended at ${facilityId} (labor action) — out of designed scope` };
    if (skuQualityHeld(disruptions, skuId, h))
      return { held: true, reason: `${skuId} under network-wide quality hold — out of designed scope` };
  }
  return { held: false, reason: "" };
}
