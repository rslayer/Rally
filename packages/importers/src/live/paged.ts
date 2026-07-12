/**
 * Generic cursor-paginated, time-windowed connector.
 *
 * Every vendor feed — telematics, WMS, ERP — is the same shape underneath: a
 * bearer-authed endpoint you page through over a `[startTime, endTime]` window,
 * mapping each row into a `FeedEnvelope`. This base captures that plumbing
 * (pagination, retry/backoff via the shared HTTP client, resumable checkpoints)
 * once, so a new source is a `path` + a `mapRow` function, not a copy-paste.
 */

import type { AnyFeedMessage } from "@rally/domain";
import { fetchJson } from "./http.js";

export interface PagedConfig {
  baseUrl: string;
  token: string;
  path: string; // e.g. "/fleet/vehicles/locations" or "/wms/transactions"
  pageLimit?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
}

export interface Page<Row> {
  data: Row[];
  pagination: { hasNextPage: boolean; endCursor: string | null };
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

export function estimateConfidence(latencyMinutes: number): number {
  return Math.max(0.6, Math.min(1, 1 - latencyMinutes / 240));
}

export function latencyMinutes(emittedAt: string, ingestedAt: string): number {
  return Math.max(0, Math.round((Date.parse(ingestedAt) - Date.parse(emittedAt)) / 60_000));
}

export class PagedConnector<Row extends { time: string }> {
  private readonly pageLimit: number;
  constructor(
    protected readonly cfg: PagedConfig,
    private readonly mapRow: (row: Row) => AnyFeedMessage,
  ) {
    this.pageLimit = cfg.pageLimit ?? 100;
  }

  private pageUrl(startTime: string, endTime: string, cursor: string | null): string {
    const u = new URL(`${this.cfg.baseUrl}${this.cfg.path}`);
    u.searchParams.set("startTime", startTime);
    u.searchParams.set("endTime", endTime);
    u.searchParams.set("limit", String(this.pageLimit));
    if (cursor) u.searchParams.set("after", cursor);
    return u.toString();
  }

  private fetchPage(url: string, stats: SyncStats): Promise<Page<Row>> {
    return fetchJson<Page<Row>>(url, {
      token: this.cfg.token,
      maxRetries: this.cfg.maxRetries ?? 4,
      backoffBaseMs: this.cfg.backoffBaseMs ?? 100,
      onRetry: ({ status }) => {
        stats.retries++;
        if (status === 429) stats.rateLimitHits++;
      },
    });
  }

  async backfill(
    startTime: string,
    endTime: string,
    opts: { checkpoint?: Checkpoint; onProgress?: (cp: Checkpoint) => void } = {},
  ): Promise<{ feeds: AnyFeedMessage[]; stats: SyncStats; checkpoint: Checkpoint }> {
    const stats: SyncStats = { pages: 0, rows: 0, retries: 0, rateLimitHits: 0 };
    const checkpoint: Checkpoint = { ...(opts.checkpoint ?? emptyCheckpoint()) };
    const feeds: AnyFeedMessage[] = [];

    let hasNext = true;
    while (hasNext) {
      const page = await this.fetchPage(this.pageUrl(startTime, endTime, checkpoint.cursor), stats);
      stats.pages++;
      for (const row of page.data) {
        feeds.push(this.mapRow(row));
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

  async *stream(startTime: string, endTime: string): AsyncGenerator<AnyFeedMessage> {
    const stats: SyncStats = { pages: 0, rows: 0, retries: 0, rateLimitHits: 0 };
    let cursor: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const page = await this.fetchPage(this.pageUrl(startTime, endTime, cursor), stats);
      for (const row of page.data) yield this.mapRow(row);
      cursor = page.pagination.endCursor;
      hasNext = page.pagination.hasNextPage;
    }
  }
}
