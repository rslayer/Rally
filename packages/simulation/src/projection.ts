/**
 * Forward projection of available inventory for a (facility, sku) cell.
 *
 * The projection is *policy-aware*: it rolls the standing periodic (s,S)
 * replenishment forward, so a projected_stockout only fires when the standing
 * policy genuinely cannot keep up (a spike, a late inbound, a supply cut) — not
 * as a baseline false alarm. This is the shared math behind the Phase-1
 * projected_stockout exception, the Phase-3 StockoutRisk, and the resolver's
 * counterfactual action evaluation (via `overrides`).
 */

import { forecastMultiplier, PLANT_ID } from "@rally/data-gen";
import { demandMultiplier } from "./apply.js";
import type { SimWorld } from "./types.js";
import { cellKey } from "./kernel-util.js";
import { REORDER_REVIEW_HOURS, replenishLeadHours } from "./lead.js";

export interface Projection {
  crosses: boolean;
  hoursToStockout: number; // Infinity if never within horizon
  shortfallUnits: number; // TOTAL unmet units over the horizon (the gap to cover)
  peakDeficitUnits: number; // worst single-hour unmet
  minAvailable: number; // lowest projected on-hand
}

/** Hypothetical adjustments used to score a candidate resolver action. */
export interface ProjOverride {
  /** Units added/removed to on-hand at `fromHour`. */
  onHandDelta?: number;
  /** Inbound arrivals to add (positive) or cancel (negative) at given hours. */
  inboundDeltas?: Array<{ hour: number; qty: number }>;
}

export function projectCell(
  world: SimWorld,
  facilityId: string,
  skuId: string,
  fromHour: number,
  horizonHours: number,
  override: ProjOverride = {},
): Projection {
  const cell = world.positions.get(cellKey(facilityId, skuId));
  if (!cell) {
    return { crosses: false, hoursToStockout: Infinity, shortfallUnits: 0, peakDeficitUnits: 0, minAvailable: 0 };
  }
  const disruptions = world.config.disruptions;

  // Known inbound arrivals from real in-flight shipments + hypothetical overrides.
  const inboundByHour = new Map<number, number>();
  for (const s of world.shipments) {
    if (s.destId !== facilityId || s.skuId !== skuId) continue;
    if (s.status !== "planned" && s.status !== "in_transit") continue;
    if (s.kind === "customer") continue;
    inboundByHour.set(s.etaHour, (inboundByHour.get(s.etaHour) ?? 0) + s.quantityUnits);
  }
  for (const delta of override.inboundDeltas ?? []) {
    inboundByHour.set(delta.hour, (inboundByHour.get(delta.hour) ?? 0) + delta.qty);
  }

  // Lead for the standing reorder that the projection assumes will keep firing.
  const lead = replenishLeadHours(world.config.network, facilityId, false);
  // Pipeline already on the water counts toward the inventory position.
  let pipeline = 0;
  for (const q of inboundByHour.values()) pipeline += Math.max(0, q);

  // On-hand floors at zero and demand that can't be served becomes unmet — the
  // same rule the kernel applies — so the total unmet the projection accumulates
  // is a faithful estimate of the service gap, not an abstract negative balance.
  const skuDef = world.config.network.skus.find((s) => s.skuId === skuId);
  const capacity = skuDef?.unitsPerRun ?? Infinity;
  const short = world.pendingShort.get(cellKey(facilityId, skuId));

  // Finite plant inventory: the total this DC can pull over the horizon is
  // bounded by the plant's current on-hand plus what it produces in the window.
  // Without this bound the projection assumes an infinite plant and declares
  // extreme-spike stockouts "recoverable" that reality cannot recover.
  const plantCell = world.positions.get(cellKey(PLANT_ID, skuId));
  const productionInHorizon = world.production.filter(
    (r) => r.skuId === skuId && r.status !== "cancelled" && r.completesAtHour > fromHour && r.completesAtHour <= fromHour + horizonHours,
  ).length * (skuDef?.unitsPerRun ?? 0);
  let plantBudget = (plantCell ? Math.max(0, plantCell.onHandUnits - plantCell.allocatedUnits) : 0) + productionInHorizon;

  let onHand = Math.max(0, cell.onHandUnits - cell.allocatedUnits + (override.onHandDelta ?? 0));
  let minAvailable = onHand;
  let hoursToStockout = Infinity;
  let cumulativeUnmet = 0;
  let peakDeficit = 0;

  for (let h = fromHour + 1; h <= fromHour + horizonHours; h++) {
    const arrived = inboundByHour.get(h) ?? 0;
    onHand += arrived;
    pipeline -= Math.max(0, arrived);

    // Standing (s,S) policy, bounded by supplier short-ship + finite plant output.
    if (h % REORDER_REVIEW_HOURS === 0) {
      const position = onHand + pipeline;
      if (position <= cell.reorderPointUnits) {
        let qty = Math.max(0, cell.orderUpToUnits - position);
        if (short && h < short.untilHour) qty = qty * (1 - short.fraction);
        qty = Math.min(qty, capacity, plantBudget);
        if (qty > 0) {
          plantBudget -= qty;
          const eta = h + lead;
          inboundByHour.set(eta, (inboundByHour.get(eta) ?? 0) + qty);
          pipeline += qty;
        }
      }
    }

    const demand =
      cell.hourlyDemand * forecastMultiplier(h) * demandMultiplier(disruptions, facilityId, skuId, h);
    const served = Math.min(demand, onHand);
    const unmet = demand - served;
    onHand -= served;
    if (onHand < minAvailable) minAvailable = onHand;
    if (unmet > 1e-6) {
      if (hoursToStockout === Infinity) hoursToStockout = h - fromHour;
      cumulativeUnmet += unmet;
      if (unmet > peakDeficit) peakDeficit = unmet;
    }
  }

  return {
    crosses: cumulativeUnmet > 1e-6,
    hoursToStockout,
    shortfallUnits: Math.round(cumulativeUnmet),
    peakDeficitUnits: Math.round(peakDeficit),
    minAvailable: Math.round(minAvailable),
  };
}
