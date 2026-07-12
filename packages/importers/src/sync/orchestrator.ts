/**
 * Multi-source ingestion orchestrator.
 *
 * A real control tower ingests several feeds at once — telematics, WMS, ERP —
 * each with its own cadence, its own watermark, and its own failure modes. This
 * orchestrator runs one `SyncEngine` per source, pulls them concurrently, and
 * merges the fresh events into a single time-ordered stream for the estimator.
 *
 * Two properties that matter operationally:
 *   • Independent state — each source keeps its own watermark/checkpoint, so a
 *     lagging or backfilling source never rewinds or skips another.
 *   • Failure isolation — if one vendor is down, its cycle records an error and
 *     does NOT advance its watermark (so it retries next cycle), while every
 *     other source syncs normally.
 */

import type { AnyFeedMessage } from "@rally/domain";
import { SyncEngine, type PullFn, type CycleStats } from "./engine.js";
import type { SyncStore } from "./store.js";

export interface Source {
  name: string;
  pull: PullFn;
  store: SyncStore;
}

export interface SourceCycleStats extends CycleStats {
  source: string;
  error?: string;
}

export interface OrchestratorResult {
  fresh: AnyFeedMessage[]; // merged, time-ordered across all sources
  bySource: SourceCycleStats[];
}

export class IngestionOrchestrator {
  private readonly engines: Map<string, SyncEngine>;
  constructor(
    private readonly sources: Source[],
    opts: { lookbackHours?: number } = {},
  ) {
    this.engines = new Map(sources.map((s) => [s.name, new SyncEngine(s.store, opts)]));
  }

  /** One cycle across all sources (concurrently), merged and time-ordered. */
  async runCycle(until: string): Promise<OrchestratorResult> {
    const results = await Promise.all(
      this.sources.map(async (s): Promise<{ fresh: AnyFeedMessage[]; stats: SourceCycleStats }> => {
        const engine = this.engines.get(s.name)!;
        try {
          const { fresh, stats } = await engine.runCycle(s.pull, until);
          return { fresh, stats: { source: s.name, ...stats } };
        } catch (err) {
          // Isolate the failure: no fresh, watermark untouched (retried next cycle).
          return {
            fresh: [],
            stats: {
              source: s.name,
              since: "",
              until,
              pulled: 0,
              fresh: 0,
              duplicates: 0,
              watermark: null,
              error: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }),
    );

    const fresh = results.flatMap((r) => r.fresh).sort((a, b) => Date.parse(a.emittedAt) - Date.parse(b.emittedAt));
    return { fresh, bySource: results.map((r) => r.stats) };
  }
}
