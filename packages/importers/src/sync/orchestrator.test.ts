import { describe, it, expect } from "vitest";
import type { AnyFeedMessage, FeedType } from "@rally/domain";
import { IngestionOrchestrator, MemorySyncStore, type PullFn, type Source } from "../index.js";

const BASE = Date.UTC(2026, 0, 5, 0, 0, 0);
const isoAt = (h: number) => new Date(BASE + h * 3_600_000).toISOString();

function mkEvent(feedId: string, feedType: FeedType, sequence: number, hour: number): AnyFeedMessage {
  return {
    feedId, feedType, sequence,
    emittedAt: isoAt(hour), ingestedAt: isoAt(hour),
    provenance: "real", quality: { latencyMinutes: 0, confidence: 1 },
    payload: (feedType === "movement"
      ? { assetId: feedId, ts: isoAt(hour), location: { lat: 0, lon: 0 }, speedMph: 0, headingDeg: 0 }
      : { facilityId: feedId, ts: isoAt(hour), type: "pick", skuId: "SKU_COLA", quantityUnits: 10 }) as any,
  };
}

function datasetPull(data: AnyFeedMessage[]): PullFn {
  return async (since, until) => {
    const lo = Date.parse(since), hi = Date.parse(until);
    return data.filter((e) => Date.parse(e.emittedAt) >= lo && Date.parse(e.emittedAt) <= hi);
  };
}

describe("IngestionOrchestrator (multi-source)", () => {
  const movement = Array.from({ length: 6 }, (_, i) => mkEvent("mov-A", "movement", i, i + 1)); // hrs 1..6
  const warehouse = Array.from({ length: 6 }, (_, i) => mkEvent("wms-DC_DAL", "warehouse", i, i + 1));

  it("syncs sources independently and merges into one time-ordered stream", async () => {
    const sources: Source[] = [
      { name: "telematics", pull: datasetPull(movement), store: new MemorySyncStore() },
      { name: "wms", pull: datasetPull(warehouse), store: new MemorySyncStore() },
    ];
    const orch = new IngestionOrchestrator(sources, { lookbackHours: 2 });
    const { fresh, bySource } = await orch.runCycle(isoAt(6));
    expect(fresh.length).toBe(12); // both sources, first cycle
    // merged is time-ordered
    const times = fresh.map((f) => Date.parse(f.emittedAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(bySource.map((s) => s.source).sort()).toEqual(["telematics", "wms"]);
  });

  it("delivers every event exactly once per source across cycles", async () => {
    const orch = new IngestionOrchestrator(
      [
        { name: "telematics", pull: datasetPull(movement), store: new MemorySyncStore() },
        { name: "wms", pull: datasetPull(warehouse), store: new MemorySyncStore() },
      ],
      { lookbackHours: 2 },
    );
    const seen = new Set<string>();
    let total = 0;
    for (const until of [2, 4, 6]) {
      const { fresh } = await orch.runCycle(isoAt(until));
      for (const m of fresh) {
        const k = `${m.feedId}#${m.sequence}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
        total++;
      }
    }
    expect(total).toBe(12);
  });

  it("isolates a failing source and recovers it next cycle without data loss", async () => {
    let wmsCalls = 0;
    const flakyWms: PullFn = async (since, until) => {
      if (wmsCalls++ === 0) throw new Error("vendor down");
      return datasetPull(warehouse)(since, until);
    };
    const orch = new IngestionOrchestrator(
      [
        { name: "telematics", pull: datasetPull(movement), store: new MemorySyncStore() },
        { name: "wms", pull: flakyWms, store: new MemorySyncStore() },
      ],
      { lookbackHours: 2 },
    );

    const c1 = await orch.runCycle(isoAt(6));
    const wms1 = c1.bySource.find((s) => s.source === "wms")!;
    expect(wms1.error).toContain("vendor down");
    expect(c1.fresh.every((f) => f.feedType === "movement")).toBe(true); // only telematics landed

    const c2 = await orch.runCycle(isoAt(6));
    const wms2 = c2.bySource.find((s) => s.source === "wms")!;
    expect(wms2.error).toBeUndefined();
    expect(c2.fresh.filter((f) => f.feedType === "warehouse").length).toBe(6); // recovered, nothing lost
    // telematics did NOT re-deliver — its watermark advanced in c1.
    expect(c2.fresh.filter((f) => f.feedType === "movement").length).toBe(0);
  });
});
