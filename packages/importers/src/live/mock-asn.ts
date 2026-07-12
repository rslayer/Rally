/** ASN-shaped mock: the generic paginated API bound to the EDI-ASN path, plus
 *  the ASN-feed → row projection. */

import type { AnyFeedMessage, AdvanceShipNotice } from "@rally/domain";
import { startMockApi, type MockHandle } from "./mock-api.js";
import type { AsnRow } from "./asn.js";

export function feedsToAsnRows(feeds: AnyFeedMessage[]): AsnRow[] {
  const rows: AsnRow[] = [];
  for (const m of feeds) {
    if (m.feedType !== "asn") continue;
    const p = m.payload as AdvanceShipNotice;
    rows.push({
      sequence: m.sequence,
      time: p.shippedAt,
      receivedAt: m.ingestedAt,
      shipmentRef: p.shipmentRef,
      originId: p.originId,
      destId: p.destId,
      sku: p.skuId,
      qty: p.quantityUnits,
      expectedArrival: p.expectedArrivalAt,
    });
  }
  return rows;
}

export function startMockAsn(opts: {
  token: string;
  rows: AsnRow[];
  pageSize?: number;
  injectRateLimitOnce?: boolean;
}): Promise<MockHandle> {
  return startMockApi<AsnRow>({ ...opts, path: "/edi/asn" });
}
