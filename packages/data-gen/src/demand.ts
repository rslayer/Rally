/**
 * Demand model. Base daily pull per (DC, SKU) with diurnal + weekly seasonality.
 * The kernel multiplies base × forecast × active-disruption multipliers each tick.
 */

import type { Network } from "@rally/domain";
import { DC_IDS } from "./network.js";

export interface DemandModel {
  /** base units/day for a (facilityId, skuId). */
  baseDaily: Record<string, number>;
}

/** Deterministic key for a DC/SKU demand cell. */
export function demandKey(facilityId: string, skuId: string): string {
  return `${facilityId}|${skuId}`;
}

/** Handbuilt base demand — tuned so a DC drains in a few days without inbound. */
export function buildDemandModel(net: Network): DemandModel {
  const perSku: Record<string, number> = {
    SKU_CHIP: 1400,
    SKU_COLA: 2000,
    SKU_BAR: 900,
  };
  // Bigger metros pull more.
  const dcScale: Record<string, number> = {
    DC_DAL: 1.3,
    DC_HOU: 1.2,
    DC_SAT: 0.9,
    DC_OKC: 0.7,
  };
  const baseDaily: Record<string, number> = {};
  for (const dc of DC_IDS) {
    for (const sku of net.skus) {
      const base = (perSku[sku.skuId] ?? 1000) * (dcScale[dc] ?? 1);
      baseDaily[demandKey(dc, sku.skuId)] = Math.round(base);
    }
  }
  return { baseDaily };
}

/**
 * Forecast multiplier at a given sim hour. Smooth diurnal peak midday, mild
 * weekly rhythm. Deterministic — the resolver can rely on it for projection.
 */
export function forecastMultiplier(hour: number): number {
  const hourOfDay = ((hour % 24) + 24) % 24;
  const dayOfWeek = Math.floor(hour / 24) % 7;
  // Diurnal: low overnight, peak ~14:00.
  const diurnal = 0.6 + 0.6 * Math.max(0, Math.sin(((hourOfDay - 6) / 24) * 2 * Math.PI));
  // Weekly: weekend uplift.
  const weekly = dayOfWeek >= 5 ? 1.15 : 1.0;
  return diurnal * weekly;
}
