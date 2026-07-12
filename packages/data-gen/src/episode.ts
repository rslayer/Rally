/** Canonical backtest episode — the fixed disruption behind the fixtures + gate. */

import type { Disruption } from "@rally/domain";

/** A resolvable heat-wave demand spike at the Dallas DC on cola — bites hard
 *  enough to carve a visible on-hand dip a backtest can lock onto. */
export const EPISODE_DISRUPTION: Disruption = {
  disruptionId: "BT-DAL-COLA-HEATWAVE",
  type: "demand_spike",
  facilityId: "DC_DAL",
  skuId: "SKU_COLA",
  startHour: 72,
  durationHours: 48,
  magnitude: 2.4,
  label: "resolvable",
  expects: "projected_stockout",
};

export const EPISODE_SEED = 4000;
export const FIXTURE_DIR = "fixtures/real-feed";
