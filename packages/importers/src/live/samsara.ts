/**
 * Live telematics connector, Samsara-shaped.
 *
 * Real analog: Samsara / Motive / Geotab fleet API. It authenticates with a
 * bearer token, pages through a time window, and maps each GPS row into the SAME
 * `FeedEnvelope<MovementEvent>` the file adapter and synthetic generator produce
 * — so a live pull and a batch export are indistinguishable downstream. All the
 * plumbing (pagination, retry/backoff, resumable checkpoints) lives in the
 * generic `PagedConnector`; this file is just the wire contract + row mapping.
 *
 * To go live, point `baseUrl` at the vendor and pass a real token from the
 * environment. Nothing else changes.
 */

import type { FeedEnvelope, MovementEvent } from "@rally/domain";
import { PagedConnector, estimateConfidence, latencyMinutes } from "./paged.js";

export interface SamsaraLocationRow {
  /** Platform event sequence for this vehicle's feed — gaps are detectable. */
  sequence: number;
  time: string; // emitted (RFC3339)
  receivedAt: string; // when the platform ingested it (drives latency)
  vehicle: { id: string };
  latitude: number;
  longitude: number;
  speedMilesPerHour: number;
  headingDegrees: number;
  shipmentRef?: string;
  geofence?: { id: string; event: "enter" | "exit" };
}

export interface SamsaraConfig {
  baseUrl: string;
  token: string;
  pageLimit?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
}

export function toEnvelope(row: SamsaraLocationRow): FeedEnvelope<MovementEvent> {
  const payload: MovementEvent = {
    assetId: row.vehicle.id,
    ts: row.time,
    location: { lat: row.latitude, lon: row.longitude },
    speedMph: row.speedMilesPerHour,
    headingDeg: row.headingDegrees,
    ...(row.shipmentRef ? { shipmentRef: row.shipmentRef } : {}),
    ...(row.geofence ? { geofenceId: row.geofence.id, geofenceTransition: row.geofence.event } : {}),
  };
  const lat = latencyMinutes(row.time, row.receivedAt);
  return {
    feedId: `mov-${row.vehicle.id}`,
    feedType: "movement",
    sequence: row.sequence,
    emittedAt: row.time,
    ingestedAt: row.receivedAt,
    provenance: "real",
    quality: { latencyMinutes: lat, confidence: estimateConfidence(lat) },
    payload,
  };
}

export class SamsaraClient extends PagedConnector<SamsaraLocationRow> {
  constructor(cfg: SamsaraConfig) {
    super({ ...cfg, path: "/fleet/vehicles/locations" }, toEnvelope);
  }
}
