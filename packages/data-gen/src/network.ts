/**
 * The Texas–Oklahoma network fixture. One region, kept small enough to reason
 * about by hand and large enough for inter-DC transfers to be a real option.
 *
 *   PLANT_DAL ──▶ DC_DAL ──▶ (customers)
 *            └──▶ DC_HOU
 *            └──▶ DC_SAT
 *            └──▶ DC_OKC
 *   DC↔DC transfer lanes exist between every DC pair (surplus rebalancing).
 */

import type { Lane, Network } from "@rally/domain";
import { haversineMiles } from "@rally/domain";

const AVG_MPH = 50;
const EXPEDITE_FACTOR = 0.6; // expedited transit is 60% of standard
const COST_PER_UNIT_MILE = 0.004;
const EXPEDITE_COST_MULT = 3;

const COORDS = {
  PLANT_DAL: { lat: 32.7767, lon: -96.797 },
  DC_DAL: { lat: 32.9, lon: -96.6 },
  DC_HOU: { lat: 29.7604, lon: -95.3698 },
  DC_SAT: { lat: 29.4241, lon: -98.4936 },
  DC_OKC: { lat: 35.4676, lon: -97.5164 },
} as const;

function makeLane(originId: keyof typeof COORDS, destId: keyof typeof COORDS): Lane {
  const miles = haversineMiles(COORDS[originId], COORDS[destId]);
  const transitHours = Math.max(2, Math.round((miles / AVG_MPH) * 10) / 10);
  const costPerUnit = Math.round(miles * COST_PER_UNIT_MILE * 100) / 100;
  return {
    laneId: `${originId}->${destId}`,
    originId,
    destId,
    transitHours,
    costPerUnit,
    expeditedTransitHours: Math.max(1, Math.round(transitHours * EXPEDITE_FACTOR * 10) / 10),
    expeditedCostPerUnit: Math.round(costPerUnit * EXPEDITE_COST_MULT * 100) / 100,
  };
}

const DCS = ["DC_DAL", "DC_HOU", "DC_SAT", "DC_OKC"] as const;

const inboundLanes: Lane[] = DCS.map((dc) => makeLane("PLANT_DAL", dc));
const transferLanes: Lane[] = DCS.flatMap((a) =>
  DCS.filter((b) => b !== a).map((b) => makeLane(a, b)),
);

export const TX_OK_NETWORK: Network = {
  networkId: "tx-ok-1",
  region: "Texas / Oklahoma",
  facilities: [
    { facilityId: "PLANT_DAL", name: "Dallas Plant", kind: "plant", location: COORDS.PLANT_DAL, geofenceRadiusMiles: 2 },
    { facilityId: "DC_DAL", name: "Dallas DC", kind: "dc", location: COORDS.DC_DAL, geofenceRadiusMiles: 2 },
    { facilityId: "DC_HOU", name: "Houston DC", kind: "dc", location: COORDS.DC_HOU, geofenceRadiusMiles: 2 },
    { facilityId: "DC_SAT", name: "San Antonio DC", kind: "dc", location: COORDS.DC_SAT, geofenceRadiusMiles: 2 },
    { facilityId: "DC_OKC", name: "Oklahoma City DC", kind: "dc", location: COORDS.DC_OKC, geofenceRadiusMiles: 2 },
  ],
  skus: [
    { skuId: "SKU_CHIP", name: "Corn Chips 12ct", unitsPerRun: 9000 },
    { skuId: "SKU_COLA", name: "Cola 24pk", unitsPerRun: 12000 },
    { skuId: "SKU_BAR", name: "Snack Bars 30ct", unitsPerRun: 6000 },
  ],
  lanes: [...inboundLanes, ...transferLanes],
  customers: [
    { customerId: "CUST_DAL_A", name: "Dallas Retail A", servedByFacilityId: "DC_DAL", location: COORDS.DC_DAL, priority: 0.9 },
    { customerId: "CUST_HOU_A", name: "Houston Retail A", servedByFacilityId: "DC_HOU", location: COORDS.DC_HOU, priority: 0.8 },
    { customerId: "CUST_SAT_A", name: "San Antonio Retail A", servedByFacilityId: "DC_SAT", location: COORDS.DC_SAT, priority: 0.7 },
    { customerId: "CUST_OKC_A", name: "OKC Retail A", servedByFacilityId: "DC_OKC", location: COORDS.DC_OKC, priority: 0.6 },
  ],
};

export const DC_IDS = DCS;
export const PLANT_ID = "PLANT_DAL";
