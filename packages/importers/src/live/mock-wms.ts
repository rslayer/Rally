/**
 * WMS-shaped mock: the generic paginated API bound to the transactions path,
 * plus the warehouse-feed → transaction-row projection.
 */

import type { AnyFeedMessage, WarehouseEvent } from "@rally/domain";
import { startMockApi, type MockHandle } from "./mock-api.js";
import type { WmsTxnRow } from "./wms.js";

/** Warehouse feed envelopes → WMS-shaped transaction rows. */
export function feedsToWmsRows(feeds: AnyFeedMessage[]): WmsTxnRow[] {
  const rows: WmsTxnRow[] = [];
  for (const m of feeds) {
    if (m.feedType !== "warehouse") continue;
    const p = m.payload as WarehouseEvent;
    rows.push({
      sequence: m.sequence,
      time: m.emittedAt,
      receivedAt: m.ingestedAt,
      facilityId: p.facilityId,
      type: p.type,
      ...(p.skuId ? { sku: p.skuId } : {}),
      ...(p.quantityUnits !== undefined ? { qty: p.quantityUnits } : {}),
      ...(p.shipmentRef ? { shipmentRef: p.shipmentRef } : {}),
      ...(p.dockDoor ? { dockDoor: p.dockDoor } : {}),
    });
  }
  return rows;
}

export function startMockWms(opts: {
  token: string;
  rows: WmsTxnRow[];
  pageSize?: number;
  injectRateLimitOnce?: boolean;
}): Promise<MockHandle> {
  return startMockApi<WmsTxnRow>({ ...opts, path: "/wms/transactions" });
}
