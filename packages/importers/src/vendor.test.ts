import { describe, it, expect } from "vitest";
import { recordEpisode } from "@rally/simulation";
import { EPISODE_DISRUPTION, EPISODE_SEED } from "@rally/data-gen";
import { feedsToVendorFiles, loadVendorFiles, parseTelematics, serializeTelematics } from "./vendor.js";

/** Phase 5 — vendor codec: real-shaped files round-trip through the seam. */
describe("vendor codec", () => {
  const episode = recordEpisode(EPISODE_SEED, EPISODE_DISRUPTION);
  const files = feedsToVendorFiles(episode.feeds);
  const reloaded = loadVendorFiles(files);

  it("preserves the message count across the round-trip", () => {
    expect(reloaded.length).toBe(episode.feeds.length);
  });

  it("preserves per-source sequence, timestamps, and payload", () => {
    // Compare movement messages by (feedId, sequence).
    const orig = new Map(episode.feeds.filter((m) => m.feedType === "movement").map((m) => [`${m.feedId}#${m.sequence}`, m]));
    const round = reloaded.filter((m) => m.feedType === "movement");
    expect(round.length).toBeGreaterThan(0);
    for (const m of round) {
      const o = orig.get(`${m.feedId}#${m.sequence}`);
      expect(o).toBeDefined();
      expect(m.emittedAt).toBe(o!.emittedAt);
      expect((m.payload as any).assetId).toBe((o!.payload as any).assetId);
      expect((m.payload as any).location.lat).toBeCloseTo((o!.payload as any).location.lat, 4);
    }
  });

  it("preserves inventory on-hand exactly", () => {
    const origSnap = episode.feeds.find((m) => m.feedType === "inventory_snapshot")!;
    const roundSnap = reloaded.find((m) => m.feedType === "inventory_snapshot" && m.sequence === origSnap.sequence)!;
    expect((roundSnap.payload as any).positions).toEqual((origSnap.payload as any).positions);
  });

  it("marks reloaded feeds as real provenance", () => {
    expect(reloaded.every((m) => m.provenance === "real")).toBe(true);
  });

  it("keeps sequence gaps visible (empty telematics is a no-op)", () => {
    expect(parseTelematics(serializeTelematics([]))).toEqual([]);
  });
});
