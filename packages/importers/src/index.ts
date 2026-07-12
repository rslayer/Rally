/**
 * @rally/importers — the real-feed seam.
 *
 * The synthetic generator and any real source (telematics, WMS, ERP extract)
 * produce the SAME `FeedEnvelope` shapes, so swapping synthetic → real is a
 * data-source change behind this one module. Nothing downstream — estimator,
 * decision engine, UI — has to move.
 *
 * This module (a) validates and normalizes inbound envelopes, tracking per-source
 * sequence gaps and lateness so the estimator can down-weight affected state, and
 * (b) provides thin example adapters that map vendor-shaped rows into envelopes.
 * A real adapter for one live source is Phase 5 (post-slice); the seam is here.
 */

import type {
  AnyFeedMessage,
  FeedEnvelope,
  FeedType,
  InventorySnapshot,
  MovementEvent,
  Provenance,
  WarehouseEvent,
} from "@rally/domain";

export * from "./vendor.js";
export * from "./live/http.js";
export * from "./live/paged.js";
export * from "./live/samsara.js";
export * from "./live/wms.js";
export * from "./live/asn.js";
export * from "./live/mock-api.js";
export * from "./live/mock-samsara.js";
export * from "./live/mock-wms.js";
export * from "./live/mock-asn.js";
export * from "./sync/store.js";
export * from "./sync/engine.js";
export * from "./sync/orchestrator.js";

export interface IngestIssue {
  feedId: string;
  sequence: number;
  kind: "gap" | "out_of_order" | "duplicate" | "malformed" | "high_latency";
  detail: string;
}

export interface IngestResult {
  messages: AnyFeedMessage[];
  issues: IngestIssue[];
}

const FEED_TYPES: FeedType[] = ["movement", "warehouse", "inventory_snapshot", "asn"];

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Structural validation of a single envelope. Returns an error string or null. */
export function validateEnvelope(m: unknown): string | null {
  if (typeof m !== "object" || m === null) return "not an object";
  const e = m as Partial<FeedEnvelope<unknown>>;
  if (typeof e.feedId !== "string" || !e.feedId) return "missing feedId";
  if (!FEED_TYPES.includes(e.feedType as FeedType)) return `bad feedType ${String(e.feedType)}`;
  if (!isFiniteNumber(e.sequence)) return "missing sequence";
  if (typeof e.emittedAt !== "string" || Number.isNaN(Date.parse(e.emittedAt))) return "bad emittedAt";
  if (typeof e.ingestedAt !== "string" || Number.isNaN(Date.parse(e.ingestedAt))) return "bad ingestedAt";
  if (e.provenance !== "synthetic" && e.provenance !== "real") return "bad provenance";
  if (typeof e.quality !== "object" || e.quality === null) return "missing quality";
  if (e.payload === undefined || e.payload === null) return "missing payload";
  return null;
}

/**
 * Ingest a batch of raw envelopes (already in FeedEnvelope shape, e.g. from the
 * synthetic generator or a normalized vendor export). Validates, sorts by source
 * sequence, and reports gaps / out-of-order / duplicates / lateness — the exact
 * signal the estimator turns into reduced confidence rather than dropped state.
 */
export function ingestFeedBatch(raw: unknown[], latencyAlertMinutes = 60): IngestResult {
  const messages: AnyFeedMessage[] = [];
  const issues: IngestIssue[] = [];

  for (const item of raw) {
    const err = validateEnvelope(item);
    if (err) {
      issues.push({ feedId: (item as any)?.feedId ?? "?", sequence: (item as any)?.sequence ?? -1, kind: "malformed", detail: err });
      continue;
    }
    const msg = item as AnyFeedMessage;
    if (msg.quality.latencyMinutes >= latencyAlertMinutes) {
      issues.push({ feedId: msg.feedId, sequence: msg.sequence, kind: "high_latency", detail: `${msg.quality.latencyMinutes}m` });
    }
    messages.push(msg);
  }

  // Per-source sequence integrity.
  const bySource = new Map<string, AnyFeedMessage[]>();
  for (const m of messages) {
    const arr = bySource.get(m.feedId) ?? [];
    arr.push(m);
    bySource.set(m.feedId, arr);
  }
  for (const [feedId, arr] of bySource) {
    arr.sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]!.sequence;
      const cur = arr[i]!.sequence;
      if (cur === prev) issues.push({ feedId, sequence: cur, kind: "duplicate", detail: `seq ${cur} repeated` });
      else if (cur > prev + 1) issues.push({ feedId, sequence: cur, kind: "gap", detail: `${cur - prev - 1} missing before seq ${cur}` });
    }
  }

  // Global time order for the estimator (it reads an ordered stream).
  messages.sort((a, b) => Date.parse(a.emittedAt) - Date.parse(b.emittedAt));
  return { messages, issues };
}

/* ---------------------- example vendor adapters ------------------------- *
 * These show the seam: a vendor row → a FeedEnvelope. A production adapter for
 * one live source (with auth, paging, backfill) is Phase 5.                  */

let seqCounters = new Map<string, number>();
export function resetAdapterState(): void {
  seqCounters = new Map();
}
function nextSeq(feedId: string): number {
  const n = (seqCounters.get(feedId) ?? 0) + 1;
  seqCounters.set(feedId, n);
  return n;
}

function envelope<T>(feedId: string, feedType: FeedType, emittedAt: string, ingestedAt: string, payload: T, provenance: Provenance = "real", confidence = 0.95): FeedEnvelope<T> {
  const latencyMinutes = Math.max(0, Math.round((Date.parse(ingestedAt) - Date.parse(emittedAt)) / 60000));
  return { feedId, feedType, sequence: nextSeq(feedId), emittedAt, ingestedAt, provenance, quality: { latencyMinutes, confidence }, payload };
}

/** Samsara/Motive/Geotab-style GPS ping row → movement envelope. */
export interface TelematicsRow {
  assetId: string;
  timestamp: string;
  lat: number;
  lon: number;
  speedMph: number;
  headingDeg: number;
  shipmentRef?: string;
  geofence?: { id: string; transition: "enter" | "exit" };
  receivedAt?: string;
}
export function fromTelematicsRow(row: TelematicsRow, feedId = `mov-${row.assetId}`): FeedEnvelope<MovementEvent> {
  const payload: MovementEvent = {
    assetId: row.assetId,
    ...(row.shipmentRef ? { shipmentRef: row.shipmentRef } : {}),
    ts: row.timestamp,
    location: { lat: row.lat, lon: row.lon },
    speedMph: row.speedMph,
    headingDeg: row.headingDeg,
    ...(row.geofence ? { geofenceId: row.geofence.id, geofenceTransition: row.geofence.transition } : {}),
  };
  return envelope(feedId, "movement", row.timestamp, row.receivedAt ?? row.timestamp, payload);
}

/** WMS transaction / EDI 940-945-style row → warehouse envelope. */
export interface WmsRow {
  facilityId: string;
  timestamp: string;
  type: WarehouseEvent["type"];
  skuId?: string;
  quantityUnits?: number;
  shipmentRef?: string;
  dockDoor?: string;
  receivedAt?: string;
}
export function fromWmsRow(row: WmsRow, feedId = `wms-${row.facilityId}`): FeedEnvelope<WarehouseEvent> {
  const payload: WarehouseEvent = {
    facilityId: row.facilityId,
    ts: row.timestamp,
    type: row.type,
    ...(row.skuId ? { skuId: row.skuId } : {}),
    ...(row.quantityUnits !== undefined ? { quantityUnits: row.quantityUnits } : {}),
    ...(row.shipmentRef ? { shipmentRef: row.shipmentRef } : {}),
    ...(row.dockDoor ? { dockDoor: row.dockDoor } : {}),
  };
  return envelope(feedId, "warehouse", row.timestamp, row.receivedAt ?? row.timestamp, payload);
}

/** ERP/WMS periodic on-hand extract → inventory snapshot envelope. */
export function fromInventoryExtract(snap: InventorySnapshot, receivedAt: string, feedId = `inv-${snap.facilityId}`): FeedEnvelope<InventorySnapshot> {
  return envelope(feedId, "inventory_snapshot", snap.ts, receivedAt, snap, "real", 1);
}
