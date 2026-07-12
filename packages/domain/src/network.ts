/** Network fixture types — the Texas–Oklahoma network. */

import type { GeoPoint } from "./geo.js";

export type FacilityKind = "plant" | "dc";

export interface Facility {
  facilityId: string;
  name: string;
  kind: FacilityKind;
  location: GeoPoint;
  /** Radius (miles) of the geofence around the facility for arrival detection. */
  geofenceRadiusMiles: number;
}

export interface Sku {
  skuId: string;
  name: string;
  /** Units produced per production run at a plant. */
  unitsPerRun: number;
}

export interface Lane {
  laneId: string;
  originId: string;
  destId: string;
  transitHours: number;
  /** Cost per unit to move on this lane at standard service. */
  costPerUnit: number;
  /** Whether this lane can be expedited, and the expedited transit hours. */
  expeditedTransitHours?: number;
  expeditedCostPerUnit?: number;
}

export interface Customer {
  customerId: string;
  name: string;
  /** DC that serves this customer. */
  servedByFacilityId: string;
  location: GeoPoint;
  /** 0..1 — priority weight used by partial-ship decisions. */
  priority: number;
}

export interface Network {
  networkId: string;
  region: string;
  facilities: Facility[];
  skus: Sku[];
  lanes: Lane[];
  customers: Customer[];
}

export function facility(net: Network, id: string): Facility {
  const f = net.facilities.find((x) => x.facilityId === id);
  if (!f) throw new Error(`unknown facility ${id}`);
  return f;
}

export function lane(net: Network, originId: string, destId: string): Lane | undefined {
  return net.lanes.find((l) => l.originId === originId && l.destId === destId);
}
