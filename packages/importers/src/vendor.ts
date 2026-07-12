/**
 * Vendor codec — the concrete edge of the real-feed seam.
 *
 * A real customer hands you exports, not our envelopes: a Samsara/Motive GPS
 * dump, a WMS transaction log, an ERP on-hand extract. This module parses those
 * vendor-shaped files into the SAME `FeedEnvelope` stream the synthetic
 * generator produces, so everything downstream (estimator, engine, UI) is
 * untouched. The symmetric serializers let us round-trip fixtures for tests.
 *
 * Vendor files carry the platform's own event sequence id and both timestamps
 * (emitted + received), so gaps and lateness survive the round-trip — the exact
 * signal the estimator turns into reduced confidence. Confidence itself is NOT
 * on the wire; we estimate it from observed latency, which is what a real
 * ingestion pipeline does.
 */

import type {
  AnyFeedMessage,
  FeedEnvelope,
  InventoryPosition,
  InventorySnapshot,
  MovementEvent,
  WarehouseEvent,
  WarehouseEventType,
} from "@rally/domain";

/* ------------------------------ CSV helpers ----------------------------- */

function splitCsv(text: string): string[][] {
  return text
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((line) => line.split(",").map((c) => c.trim()));
}

function rows(text: string): Array<Record<string, string>> {
  const lines = splitCsv(text);
  if (lines.length < 2) return [];
  const header = lines[0]!;
  return lines.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = cells[i] ?? ""));
    return rec;
  });
}

const num = (s: string): number => (s === "" ? 0 : Number(s));
const csvCell = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** Confidence a real pipeline would assign, purely from observed latency. */
function estimateConfidence(latencyMinutes: number): number {
  return Math.max(0.6, Math.min(1, 1 - latencyMinutes / 240));
}

function latencyMinutes(emittedAt: string, ingestedAt: string): number {
  return Math.max(0, Math.round((Date.parse(ingestedAt) - Date.parse(emittedAt)) / 60000));
}

/* ------------------------------- telematics ----------------------------- */

export const TELEMATICS_HEADER =
  "seq,event_ts,ingest_ts,asset_id,lat,lon,speed_mph,heading_deg,shipment_ref,geofence_id,geofence_event";

export function serializeTelematics(feeds: AnyFeedMessage[]): string {
  const lines = [TELEMATICS_HEADER];
  for (const m of feeds) {
    if (m.feedType !== "movement") continue;
    const p = m.payload as MovementEvent;
    lines.push(
      [
        m.sequence, m.emittedAt, m.ingestedAt, p.assetId, p.location.lat, p.location.lon,
        p.speedMph, p.headingDeg, csvCell(p.shipmentRef), csvCell(p.geofenceId), csvCell(p.geofenceTransition),
      ].map(csvCell).join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function parseTelematics(text: string): FeedEnvelope<MovementEvent>[] {
  return rows(text).map((r) => {
    const lat = num(r.lat!);
    const payload: MovementEvent = {
      assetId: r.asset_id!,
      ts: r.event_ts!,
      location: { lat, lon: num(r.lon!) },
      speedMph: num(r.speed_mph!),
      headingDeg: num(r.heading_deg!),
      ...(r.shipment_ref ? { shipmentRef: r.shipment_ref } : {}),
      ...(r.geofence_id ? { geofenceId: r.geofence_id } : {}),
      ...(r.geofence_event === "enter" || r.geofence_event === "exit"
        ? { geofenceTransition: r.geofence_event as "enter" | "exit" }
        : {}),
    };
    const lat_m = latencyMinutes(r.event_ts!, r.ingest_ts!);
    return {
      feedId: `mov-${r.asset_id}`,
      feedType: "movement",
      sequence: num(r.seq!),
      emittedAt: r.event_ts!,
      ingestedAt: r.ingest_ts!,
      provenance: "real",
      quality: { latencyMinutes: lat_m, confidence: estimateConfidence(lat_m) },
      payload,
    };
  });
}

/* --------------------------------- WMS ---------------------------------- */

export const WMS_HEADER = "seq,event_ts,ingest_ts,facility_id,txn_type,sku,qty,shipment_ref,dock_door";

const WMS_TYPES: WarehouseEventType[] = ["receipt", "putaway", "pick", "pack", "ship_confirm", "cycle_count", "adjustment"];

export function serializeWms(feeds: AnyFeedMessage[]): string {
  const lines = [WMS_HEADER];
  for (const m of feeds) {
    if (m.feedType !== "warehouse") continue;
    const p = m.payload as WarehouseEvent;
    lines.push(
      [
        m.sequence, m.emittedAt, m.ingestedAt, p.facilityId, p.type, csvCell(p.skuId),
        csvCell(p.quantityUnits), csvCell(p.shipmentRef), csvCell(p.dockDoor),
      ].map(csvCell).join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function parseWms(text: string): FeedEnvelope<WarehouseEvent>[] {
  return rows(text).map((r) => {
    const type = (WMS_TYPES.includes(r.txn_type as WarehouseEventType) ? r.txn_type : "adjustment") as WarehouseEventType;
    const payload: WarehouseEvent = {
      facilityId: r.facility_id!,
      ts: r.event_ts!,
      type,
      ...(r.sku ? { skuId: r.sku } : {}),
      ...(r.qty !== "" ? { quantityUnits: num(r.qty!) } : {}),
      ...(r.shipment_ref ? { shipmentRef: r.shipment_ref } : {}),
      ...(r.dock_door ? { dockDoor: r.dock_door } : {}),
    };
    const lat_m = latencyMinutes(r.event_ts!, r.ingest_ts!);
    return {
      feedId: `wms-${r.facility_id}`,
      feedType: "warehouse",
      sequence: num(r.seq!),
      emittedAt: r.event_ts!,
      ingestedAt: r.ingest_ts!,
      provenance: "real",
      quality: { latencyMinutes: lat_m, confidence: estimateConfidence(lat_m) },
      payload,
    };
  });
}

/* ------------------------------ inventory ------------------------------- */

interface InventoryJsonEntry {
  seq: number;
  as_of: string;
  received: string;
  facility_id: string;
  positions: Array<{ sku: string; on_hand: number; allocated: number }>;
}

export function serializeInventory(feeds: AnyFeedMessage[]): string {
  const out: InventoryJsonEntry[] = [];
  for (const m of feeds) {
    if (m.feedType !== "inventory_snapshot") continue;
    const p = m.payload as InventorySnapshot;
    out.push({
      seq: m.sequence,
      as_of: p.ts,
      received: m.ingestedAt,
      facility_id: p.facilityId,
      positions: p.positions.map((x) => ({ sku: x.skuId, on_hand: x.onHandUnits, allocated: x.allocatedUnits })),
    });
  }
  return JSON.stringify(out, null, 2) + "\n";
}

export function parseInventory(text: string): FeedEnvelope<InventorySnapshot>[] {
  const entries = JSON.parse(text) as InventoryJsonEntry[];
  return entries.map((e) => {
    const positions: InventoryPosition[] = e.positions.map((x) => ({
      skuId: x.sku,
      onHandUnits: x.on_hand,
      allocatedUnits: x.allocated,
      availableUnits: Math.max(0, x.on_hand - x.allocated),
    }));
    const payload: InventorySnapshot = { facilityId: e.facility_id, ts: e.as_of, positions };
    const lat_m = latencyMinutes(e.as_of, e.received);
    return {
      feedId: `inv-${e.facility_id}`,
      feedType: "inventory_snapshot",
      sequence: e.seq,
      emittedAt: e.as_of,
      ingestedAt: e.received,
      provenance: "real",
      quality: { latencyMinutes: lat_m, confidence: 1 },
      payload,
    };
  });
}

/* --------------------------------- API ---------------------------------- */

export interface VendorFiles {
  telematics: string;
  wms: string;
  inventory: string;
}

/** Serialize a synthetic feed stream into vendor-shaped export files. */
export function feedsToVendorFiles(feeds: AnyFeedMessage[]): VendorFiles {
  return {
    telematics: serializeTelematics(feeds),
    wms: serializeWms(feeds),
    inventory: serializeInventory(feeds),
  };
}

/** Parse vendor-shaped export files into the shared feed stream. */
export function loadVendorFiles(files: Partial<VendorFiles>): AnyFeedMessage[] {
  const out: AnyFeedMessage[] = [];
  if (files.telematics) out.push(...parseTelematics(files.telematics));
  if (files.wms) out.push(...parseWms(files.wms));
  if (files.inventory) out.push(...parseInventory(files.inventory));
  return out;
}
