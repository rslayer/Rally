/**
 * Live ASN connector, EDI 856-shaped.
 *
 * Real analog: an advance-ship-notice feed (EDI 856) the shipper pushes ahead of
 * the truck. It's the feed that closes the inbound-visibility gap Slice 7
 * measured — it declares the destination + quantity + promised arrival up front,
 * so the estimator sees in-flight inbound without joining telematics for a dest.
 * Rides the same generic PagedConnector as every other source.
 */

import type { AdvanceShipNotice, FeedEnvelope } from "@rally/domain";
import { PagedConnector, estimateConfidence, latencyMinutes } from "./paged.js";

export interface AsnRow {
  sequence: number;
  time: string; // shipped_at (emitted)
  receivedAt: string;
  shipmentRef: string;
  originId: string;
  destId: string;
  sku: string;
  qty: number;
  expectedArrival: string;
}

export interface AsnConfig {
  baseUrl: string;
  token: string;
  pageLimit?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
}

export function asnToEnvelope(row: AsnRow): FeedEnvelope<AdvanceShipNotice> {
  const payload: AdvanceShipNotice = {
    shipmentRef: row.shipmentRef,
    originId: row.originId,
    destId: row.destId,
    skuId: row.sku,
    quantityUnits: row.qty,
    shippedAt: row.time,
    expectedArrivalAt: row.expectedArrival,
  };
  const lat = latencyMinutes(row.time, row.receivedAt);
  return {
    feedId: `asn-${row.originId}`,
    feedType: "asn",
    sequence: row.sequence,
    emittedAt: row.time,
    ingestedAt: row.receivedAt,
    provenance: "real",
    quality: { latencyMinutes: lat, confidence: estimateConfidence(lat) },
    payload,
  };
}

export class AsnClient extends PagedConnector<AsnRow> {
  constructor(cfg: AsnConfig) {
    super({ ...cfg, path: "/edi/asn" }, asnToEnvelope);
  }
}
