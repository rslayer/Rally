import { describe, it, expect } from "vitest";
import type { AnyFeedMessage } from "@rally/domain";
import { SyncEngine, MemorySyncStore, type PullFn } from "../index.js";

const BASE = Date.UTC(2026, 0, 5, 0, 0, 0);
const isoAt = (hour: number) => new Date(BASE + hour * 3_600_000).toISOString();

function mkEvent(feedId: string, sequence: number, hour: number): AnyFeedMessage {
  return {
    feedId,
    feedType: "movement",
    sequence,
    emittedAt: isoAt(hour),
    ingestedAt: isoAt(hour),
    provenance: "real",
    quality: { latencyMinutes: 0, confidence: 1 },
    payload: { assetId: feedId, ts: isoAt(hour), location: { lat: 0, lon: 0 }, speedMph: 0, headingDeg: 0 },
  };
}

/** A time-windowing pull over a mutable dataset — mimics a real API's filter. */
function datasetPull(data: AnyFeedMessage[]): PullFn {
  return async (since, until) => {
    const lo = Date.parse(since);
    const hi = Date.parse(until);
    return data.filter((e) => {
      const t = Date.parse(e.emittedAt);
      return t >= lo && t <= hi;
    });
  };
}

describe("SyncEngine (incremental sync)", () => {
  const data = Array.from({ length: 10 }, (_, i) => mkEvent("mov-A", i + 1, i + 1)); // hours 1..10

  it("is idempotent — re-running the same window yields zero fresh", async () => {
    const engine = new SyncEngine(new MemorySyncStore(), { lookbackHours: 6 });
    const pull = datasetPull(data);
    const c1 = await engine.runCycle(pull, isoAt(5));
    expect(c1.stats.fresh).toBe(5);
    const c2 = await engine.runCycle(pull, isoAt(5));
    expect(c2.stats.fresh).toBe(0);
    expect(c2.stats.duplicates).toBeGreaterThan(0); // lookback re-scanned, all deduped
  });

  it("delivers every event exactly once across advancing cycles", async () => {
    const engine = new SyncEngine(new MemorySyncStore(), { lookbackHours: 6 });
    const pull = datasetPull(data);
    const seen = new Set<string>();
    let total = 0;
    for (const until of [3, 6, 9, 12]) {
      const { fresh } = await engine.runCycle(pull, isoAt(until));
      for (const m of fresh) {
        expect(seen.has(`${m.feedId}#${m.sequence}`)).toBe(false); // never twice
        seen.add(`${m.feedId}#${m.sequence}`);
        total++;
      }
    }
    expect(total).toBe(10); // all distinct events, exactly once
  });

  it("resumes from persisted state after a restart", async () => {
    const store = new MemorySyncStore();
    const pull = datasetPull(data);
    await new SyncEngine(store, { lookbackHours: 6 }).runCycle(pull, isoAt(5));
    // Brand-new engine, same store — must not re-deliver the first five.
    const resumed = await new SyncEngine(store, { lookbackHours: 6 }).runCycle(pull, isoAt(10));
    expect(resumed.stats.fresh).toBe(5);
    expect(resumed.fresh.map((m) => m.sequence).sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10]);
  });

  it("catches a late-arriving event inside the lookback window", async () => {
    const partial = data.filter((e) => e.sequence !== 4); // hour-4 event is late
    const live = [...partial];
    const engine = new SyncEngine(new MemorySyncStore(), { lookbackHours: 6 });
    const pull = datasetPull(live);
    const c1 = await engine.runCycle(pull, isoAt(5));
    expect(c1.fresh.map((m) => m.sequence)).not.toContain(4);
    // The hour-4 event lands late; a same-window cycle re-scans and picks it up.
    live.push(mkEvent("mov-A", 4, 4));
    const c2 = await engine.runCycle(pull, isoAt(5));
    expect(c2.fresh.map((m) => m.sequence)).toEqual([4]);
  });

  it("keeps the seen-set bounded to the lookback window", async () => {
    const store = new MemorySyncStore();
    const engine = new SyncEngine(store, { lookbackHours: 6 });
    const pull = datasetPull(data);
    await engine.runCycle(pull, isoAt(10)); // watermark → 10h
    // Only events within [10h-6h, 10h] should remain tracked.
    expect(store.load().seen.length).toBeLessThanOrEqual(7);
  });
});
