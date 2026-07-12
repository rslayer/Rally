/**
 * Live warehouse connector, WMS/EDI-shaped.
 *
 * Real analog: a WMS transaction API (Blue Yonder / Manhattan) or an EDI 940/945
 * shipping-advice feed. It's a *different* feed type with different semantics
 * than telematics — yet it rides the exact same generic connector, proving the
 * seam isn't telematics-specific: a new source is a wire contract + a row map.
 */

import type { FeedEnvelope, WarehouseEvent, WarehouseEventType } from "@rally/domain";
import { PagedConnector, estimateConfidence, latencyMinutes } from "./paged.js";

const WMS_TYPES: WarehouseEventType[] = [
  "receipt", "putaway", "pick", "pack", "ship_confirm", "cycle_count", "adjustment",
];

export interface WmsTxnRow {
  sequence: number;
  time: string; // emitted (RFC3339)
  receivedAt: string;
  facilityId: string;
  type: string; // vendor transaction code; validated on map
  sku?: string;
  qty?: number;
  shipmentRef?: string;
  dockDoor?: string;
}

export interface WmsConfig {
  baseUrl: string;
  token: string;
  pageLimit?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
}

export function wmsToEnvelope(row: WmsTxnRow): FeedEnvelope<WarehouseEvent> {
  const type = (WMS_TYPES.includes(row.type as WarehouseEventType) ? row.type : "adjustment") as WarehouseEventType;
  const payload: WarehouseEvent = {
    facilityId: row.facilityId,
    ts: row.time,
    type,
    ...(row.sku ? { skuId: row.sku } : {}),
    ...(row.qty !== undefined ? { quantityUnits: row.qty } : {}),
    ...(row.shipmentRef ? { shipmentRef: row.shipmentRef } : {}),
    ...(row.dockDoor ? { dockDoor: row.dockDoor } : {}),
  };
  const lat = latencyMinutes(row.time, row.receivedAt);
  return {
    feedId: `wms-${row.facilityId}`,
    feedType: "warehouse",
    sequence: row.sequence,
    emittedAt: row.time,
    ingestedAt: row.receivedAt,
    provenance: "real",
    quality: { latencyMinutes: lat, confidence: estimateConfidence(lat) },
    payload,
  };
}

export class WmsClient extends PagedConnector<WmsTxnRow> {
  constructor(cfg: WmsConfig) {
    super({ ...cfg, path: "/wms/transactions" }, wmsToEnvelope);
  }
}
