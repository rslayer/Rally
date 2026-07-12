/**
 * Live telematics connector, Samsara-shaped.
 *
 * Real analog: Samsara / Motive / Geotab fleet API. It authenticates with a
 * bearer token, pages through a time window via cursor pagination, and maps each
 * GPS row into the SAME `FeedEnvelope<MovementEvent>` the file adapter and
 * synthetic generator produce — so a live pull and a batch export are
 * indistinguishable to everything downstream.
 *
 * Backfill is resumable: the caller gets a `Checkpoint` after every page and can
 * persist it, so a crashed or rate-limited sync picks up exactly where it left
 * off instead of re-pulling (or worse, skipping) data.
 *
 * To go live, point `baseUrl` at the vendor and pass a real token from the
 * environment. Nothing else changes.
 */

import type { FeedEnvelope, MovementEvent } from "@rally/domain";
import { fetchJson } from "./http.js";

/* ----------------------------- wire contract ---------------------------- */

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

export interface SamsaraPage {
  data: SamsaraLocationRow[];
  pagination: { hasNextPage: boolean; endCursor: string | null };
}

export interface SamsaraConfig {
  baseUrl: string;
  token: string;
  pageLimit?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
}

/** Resumable position in a backfill. Persist it to survive a restart. */
export interface Checkpoint {
  cursor: string | null;
  lastTime: string | null;
  pagesFetched: number;
  rowsFetched: number;
}

export interface SyncStats {
  pages: number;
  rows: number;
  retries: number;
  rateLimitHits: number;
}

export function emptyCheckpoint(): Checkpoint {
  return { cursor: null, lastTime: null, pagesFetched: 0, rowsFetched: 0 };
}

function estimateConfidence(latencyMinutes: number): number {
  return Math.max(0.6, Math.min(1, 1 - latencyMinutes / 240));
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
  const latencyMinutes = Math.max(0, Math.round((Date.parse(row.receivedAt) - Date.parse(row.time)) / 60_000));
  return {
    feedId: `mov-${row.vehicle.id}`,
    feedType: "movement",
    sequence: row.sequence,
    emittedAt: row.time,
    ingestedAt: row.receivedAt,
    provenance: "real",
    quality: { latencyMinutes, confidence: estimateConfidence(latencyMinutes) },
    payload,
  };
}

/* ------------------------------- client --------------------------------- */

export class SamsaraClient {
  private readonly pageLimit: number;
  constructor(private readonly cfg: SamsaraConfig) {
    this.pageLimit = cfg.pageLimit ?? 100;
  }

  private pageUrl(startTime: string, endTime: string, cursor: string | null): string {
    const u = new URL(`${this.cfg.baseUrl}/fleet/vehicles/locations`);
    u.searchParams.set("startTime", startTime);
    u.searchParams.set("endTime", endTime);
    u.searchParams.set("limit", String(this.pageLimit));
    if (cursor) u.searchParams.set("after", cursor);
    return u.toString();
  }

  private async fetchPage(url: string, stats: SyncStats): Promise<SamsaraPage> {
    return fetchJson<SamsaraPage>(url, {
      token: this.cfg.token,
      maxRetries: this.cfg.maxRetries ?? 4,
      backoffBaseMs: this.cfg.backoffBaseMs ?? 100,
      onRetry: ({ status }) => {
        stats.retries++;
        if (status === 429) stats.rateLimitHits++;
      },
    });
  }

  /**
   * Backfill an interval, resuming from `checkpoint` if given. Calls
   * `onProgress` with an updated checkpoint after each page so the caller can
   * persist progress and resume mid-stream.
   */
  async backfill(
    startTime: string,
    endTime: string,
    opts: { checkpoint?: Checkpoint; onProgress?: (cp: Checkpoint) => void } = {},
  ): Promise<{ feeds: FeedEnvelope<MovementEvent>[]; stats: SyncStats; checkpoint: Checkpoint }> {
    const stats: SyncStats = { pages: 0, rows: 0, retries: 0, rateLimitHits: 0 };
    const checkpoint: Checkpoint = { ...(opts.checkpoint ?? emptyCheckpoint()) };
    const feeds: FeedEnvelope<MovementEvent>[] = [];

    let hasNext = true;
    while (hasNext) {
      const page = await this.fetchPage(this.pageUrl(startTime, endTime, checkpoint.cursor), stats);
      stats.pages++;
      for (const row of page.data) {
        feeds.push(toEnvelope(row));
        checkpoint.rowsFetched++;
        checkpoint.lastTime = row.time;
        stats.rows++;
      }
      checkpoint.cursor = page.pagination.endCursor;
      checkpoint.pagesFetched++;
      hasNext = page.pagination.hasNextPage;
      opts.onProgress?.({ ...checkpoint });
    }
    return { feeds, stats, checkpoint };
  }

  /** Convenience async-iterator over the same backfill. */
  async *stream(startTime: string, endTime: string): AsyncGenerator<FeedEnvelope<MovementEvent>> {
    const stats: SyncStats = { pages: 0, rows: 0, retries: 0, rateLimitHits: 0 };
    let cursor: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const page = await this.fetchPage(this.pageUrl(startTime, endTime, cursor), stats);
      for (const row of page.data) yield toEnvelope(row);
      cursor = page.pagination.endCursor;
      hasNext = page.pagination.hasNextPage;
    }
  }
}
