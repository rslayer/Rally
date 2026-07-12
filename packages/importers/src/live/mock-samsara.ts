/**
 * Samsara-shaped mock: the generic paginated API bound to the fleet-locations
 * path, plus the movement-feed → GPS-row projection. A reusable connector test
 * double (domain-only deps).
 */

import type { AnyFeedMessage, MovementEvent } from "@rally/domain";
import { startMockApi, type MockHandle } from "./mock-api.js";
import type { SamsaraLocationRow } from "./samsara.js";

/** Movement feed envelopes → Samsara-shaped GPS rows. */
export function feedsToRows(feeds: AnyFeedMessage[]): SamsaraLocationRow[] {
  const rows: SamsaraLocationRow[] = [];
  for (const m of feeds) {
    if (m.feedType !== "movement") continue;
    const p = m.payload as MovementEvent;
    rows.push({
      sequence: m.sequence,
      time: m.emittedAt,
      receivedAt: m.ingestedAt,
      vehicle: { id: p.assetId },
      latitude: p.location.lat,
      longitude: p.location.lon,
      speedMilesPerHour: p.speedMph,
      headingDegrees: p.headingDeg,
      ...(p.shipmentRef ? { shipmentRef: p.shipmentRef } : {}),
      ...(p.geofenceId && p.geofenceTransition ? { geofence: { id: p.geofenceId, event: p.geofenceTransition } } : {}),
    });
  }
  return rows;
}

export function startMockSamsara(opts: {
  token: string;
  rows: SamsaraLocationRow[];
  pageSize?: number;
  injectRateLimitOnce?: boolean;
}): Promise<MockHandle> {
  return startMockApi<SamsaraLocationRow>({ ...opts, path: "/fleet/vehicles/locations" });
}
