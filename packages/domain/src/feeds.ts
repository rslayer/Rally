/**
 * Part A — State layer feed contract.
 *
 * Every input to the engine arrives as an event or snapshot shaped like a real
 * telematics, WMS, or inventory feed. Synthetic and real sources share this one
 * envelope, so synthetic→real is a data-source swap at a single seam.
 */

import type { GeoPoint } from "./geo.js";

export type FeedType = "movement" | "warehouse" | "inventory_snapshot" | "asn" | "ops_status";
export type Provenance = "synthetic" | "real";

export interface FeedQuality {
  latencyMinutes: number; // ingestedAt - emittedAt
  confidence: number; // 0..1, source-reported or estimated
}

export interface FeedEnvelope<T> {
  feedId: string;
  feedType: FeedType;
  sequence: number; // per-source monotonic; used to detect gaps
  emittedAt: string; // ISO — when the source produced it
  ingestedAt: string; // ISO — when the platform received it (may lag emittedAt)
  provenance: Provenance;
  quality: FeedQuality;
  payload: T;
}

/* ------------------------------------------------------------------ *
 * Movement feed (telematics-shaped).
 * Real analog: Samsara / Motive / Geotab ping, or private-fleet ELD.
 * ------------------------------------------------------------------ */

export type GeofenceTransition = "enter" | "exit";

export interface MovementEvent {
  assetId: string; // truck or trailer
  shipmentRef?: string; // may be absent; estimator must associate
  ts: string;
  location: GeoPoint;
  speedMph: number;
  headingDeg: number;
  geofenceId?: string;
  geofenceTransition?: GeofenceTransition; // dock/facility arrival + departure
}

/* ------------------------------------------------------------------ *
 * Warehouse feed (WMS-shaped).
 * Real analog: WMS transaction log or EDI 940/945.
 * ------------------------------------------------------------------ */

export type WarehouseEventType =
  | "receipt"
  | "putaway"
  | "pick"
  | "pack"
  | "ship_confirm"
  | "cycle_count"
  | "adjustment";

export interface WarehouseEvent {
  facilityId: string;
  ts: string;
  type: WarehouseEventType;
  skuId?: string;
  quantityUnits?: number;
  shipmentRef?: string;
  dockDoor?: string;
}

/* ------------------------------------------------------------------ *
 * Inventory feed (ERP/WMS extract-shaped).
 * Deliberately periodic and lagging: the estimator must interpolate
 * between snapshots using the warehouse event stream.
 * ------------------------------------------------------------------ */

export interface InventoryPosition {
  skuId: string;
  onHandUnits: number;
  allocatedUnits: number;
  availableUnits: number; // onHand - allocated
}

export interface InventorySnapshot {
  facilityId: string;
  ts: string;
  positions: InventoryPosition[];
}

/* ------------------------------------------------------------------ *
 * ASN feed (advance ship notice, EDI 856-shaped).
 * Real analog: an EDI 856 the shipper sends AHEAD of the shipment. Unlike a WMS
 * ship-confirm, it declares the DESTINATION and promised arrival up front, so
 * the estimator can see in-flight inbound without joining telematics for a dest.
 * ------------------------------------------------------------------ */

export interface AdvanceShipNotice {
  shipmentRef: string;
  originId: string;
  destId: string;
  skuId: string;
  quantityUnits: number;
  shippedAt: string; // when it left origin
  expectedArrivalAt: string; // promised delivery (ETA)
}

/* ------------------------------------------------------------------ *
 * Operational-status feed (ops / EDI 824-style status message).
 * Real analog: a facility ops system reporting a dock/labor stoppage, or a
 * quality system reporting a network-wide SKU quarantine. It makes the two
 * held-out disruption types OBSERVABLE, so the resolver escalates them from
 * sensed status rather than privileged knowledge.
 * ------------------------------------------------------------------ */

export type OpsStatusType = "facility_throughput" | "sku_quality_hold";

export interface OperationalStatus {
  type: OpsStatusType;
  facilityId?: string; // set for facility_throughput
  skuId?: string; // set for sku_quality_hold
  /** true = the hold is in effect; false = it has been lifted. */
  active: boolean;
  effectiveAt: string;
  note?: string;
}

/** Discriminated union carried on the wire, one envelope per message. */
export type AnyFeedMessage =
  | FeedEnvelope<MovementEvent>
  | FeedEnvelope<WarehouseEvent>
  | FeedEnvelope<InventorySnapshot>
  | FeedEnvelope<AdvanceShipNotice>
  | FeedEnvelope<OperationalStatus>;

export function isMovement(
  m: AnyFeedMessage,
): m is FeedEnvelope<MovementEvent> {
  return m.feedType === "movement";
}
export function isWarehouse(
  m: AnyFeedMessage,
): m is FeedEnvelope<WarehouseEvent> {
  return m.feedType === "warehouse";
}
export function isInventorySnapshot(
  m: AnyFeedMessage,
): m is FeedEnvelope<InventorySnapshot> {
  return m.feedType === "inventory_snapshot";
}
export function isAsn(m: AnyFeedMessage): m is FeedEnvelope<AdvanceShipNotice> {
  return m.feedType === "asn";
}
export function isOpsStatus(m: AnyFeedMessage): m is FeedEnvelope<OperationalStatus> {
  return m.feedType === "ops_status";
}
