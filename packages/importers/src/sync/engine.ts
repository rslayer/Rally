/**
 * Incremental sync engine — connector-agnostic.
 *
 * A live integration can't backfill the whole history every cycle; it must pull
 * only what's new, survive restarts, and never double-count. This engine does
 * that on top of any connector that can answer "give me events in [since, until]"
 * (the Samsara client's `backfill`, a WMS pull, anything):
 *
 *   • Watermark — advance a high-water mark to the newest event actually seen.
 *   • Lookback  — re-scan a small window behind the watermark each cycle so
 *     late-arriving events (ingested long after emitted) are not missed.
 *   • Dedup     — drop anything whose `feedId#sequence` we've already emitted,
 *     so the lookback re-scan doesn't produce duplicates.
 *   • Resumable — all of the above lives in a `SyncStore`, so a crashed poller
 *     picks up exactly where it left off.
 *
 * The engine takes `until` as a parameter (never reads the wall clock), so runs
 * are deterministic and testable.
 */

import type { AnyFeedMessage } from "@rally/domain";
import type { SyncStore, SyncState } from "./store.js";

export type PullFn = (since: string, until: string) => Promise<AnyFeedMessage[]>;

export interface CycleStats {
  since: string;
  until: string;
  pulled: number;
  fresh: number;
  duplicates: number;
  watermark: string | null;
}

export interface CycleResult {
  fresh: AnyFeedMessage[];
  stats: CycleStats;
}

export function eventKey(m: AnyFeedMessage): string {
  return `${m.feedId}#${m.sequence}`;
}

const EPOCH_ISO = new Date(0).toISOString();

export interface SyncEngineOptions {
  /** How far behind the watermark to re-scan each cycle for late arrivals. */
  lookbackHours?: number;
}

export class SyncEngine {
  private readonly lookbackMs: number;
  constructor(
    private readonly store: SyncStore,
    opts: SyncEngineOptions = {},
  ) {
    this.lookbackMs = (opts.lookbackHours ?? 6) * 3_600_000;
  }

  /** Run one incremental cycle up to `until`, returning only the fresh events. */
  async runCycle(pull: PullFn, until: string): Promise<CycleResult> {
    const state = this.store.load();
    const seen = new Map<string, number>(state.seen);

    const since = state.watermark
      ? new Date(Date.parse(state.watermark) - this.lookbackMs).toISOString()
      : EPOCH_ISO;

    const pulled = await pull(since, until);

    const fresh: AnyFeedMessage[] = [];
    let maxEmit = state.watermark ? Date.parse(state.watermark) : Number.NEGATIVE_INFINITY;
    for (const m of pulled) {
      const key = eventKey(m);
      const at = Date.parse(m.emittedAt);
      if (Number.isFinite(at) && at > maxEmit) maxEmit = at;
      if (!seen.has(key)) fresh.push(m);
      seen.set(key, at); // mark seen (or refresh) whether fresh or duplicate
    }

    const watermark = Number.isFinite(maxEmit) ? new Date(maxEmit).toISOString() : state.watermark;

    // Prune the seen-set to the lookback window so it stays bounded.
    const cutoff = Number.isFinite(maxEmit) ? maxEmit - this.lookbackMs : Number.NEGATIVE_INFINITY;
    for (const [key, at] of seen) if (at < cutoff) seen.delete(key);

    const next: SyncState = { watermark, seen: [...seen] };
    this.store.save(next);

    return {
      fresh,
      stats: { since, until, pulled: pulled.length, fresh: fresh.length, duplicates: pulled.length - fresh.length, watermark },
    };
  }
}
