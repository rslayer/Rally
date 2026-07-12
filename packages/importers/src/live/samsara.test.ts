import { describe, it, expect } from "vitest";
import { SamsaraClient, HttpError, toEnvelope, type Checkpoint, type SamsaraLocationRow } from "../index.js";
import { startMockSamsara } from "./mock-samsara.js";

const BASE = Date.UTC(2026, 0, 5, 0, 0, 0);
function makeRows(n: number): SamsaraLocationRow[] {
  return Array.from({ length: n }, (_, i) => ({
    sequence: i,
    time: new Date(BASE + i * 60_000).toISOString(),
    receivedAt: new Date(BASE + i * 60_000 + 120_000).toISOString(), // 2-min latency
    vehicle: { id: "TRK-1" },
    latitude: 32.7 + i * 0.001,
    longitude: -96.8,
    speedMilesPerHour: 55,
    headingDegrees: 90,
    shipmentRef: i % 2 === 0 ? `SHIP-${i}` : undefined,
  }));
}
const START = new Date(BASE).toISOString();
const END = new Date(BASE + 60 * 60_000).toISOString();

describe("SamsaraClient (live connector)", () => {
  it("assembles every page in order via cursor pagination", async () => {
    const mock = await startMockSamsara({ token: "t", rows: makeRows(25), pageSize: 10 });
    try {
      const client = new SamsaraClient({ baseUrl: mock.url, token: "t", pageLimit: 10 });
      const { feeds, stats } = await client.backfill(START, END);
      expect(feeds.length).toBe(25);
      expect(stats.pages).toBe(3); // 10 + 10 + 5
      expect(feeds.map((f) => f.sequence)).toEqual([...Array(25).keys()]);
    } finally {
      await mock.close();
    }
  });

  it("rejects a bad token and does NOT retry auth failures", async () => {
    const mock = await startMockSamsara({ token: "right", rows: makeRows(5), pageSize: 10 });
    try {
      const client = new SamsaraClient({ baseUrl: mock.url, token: "wrong", maxRetries: 3 });
      await expect(client.backfill(START, END)).rejects.toBeInstanceOf(HttpError);
      expect(mock.requestCount()).toBe(1); // one shot, no retry storm
    } finally {
      await mock.close();
    }
  });

  it("backs off and retries a 429, then succeeds", async () => {
    const mock = await startMockSamsara({ token: "t", rows: makeRows(12), pageSize: 10, injectRateLimitOnce: true });
    try {
      const client = new SamsaraClient({ baseUrl: mock.url, token: "t", pageLimit: 10, backoffBaseMs: 1 });
      const { feeds, stats } = await client.backfill(START, END);
      expect(feeds.length).toBe(12);
      expect(stats.rateLimitHits).toBeGreaterThanOrEqual(1);
      expect(stats.retries).toBeGreaterThanOrEqual(1);
    } finally {
      await mock.close();
    }
  });

  it("resumes from a persisted checkpoint without gaps or duplicates", async () => {
    const mock = await startMockSamsara({ token: "t", rows: makeRows(25), pageSize: 10 });
    try {
      const client = new SamsaraClient({ baseUrl: mock.url, token: "t", pageLimit: 10 });
      const cps: Checkpoint[] = [];
      const full = await client.backfill(START, END, { onProgress: (cp) => cps.push({ ...cp }) });
      const afterPage1 = cps[0]!; // cursor sits after the first 10 rows

      const resumed = await client.backfill(START, END, { checkpoint: afterPage1 });
      expect(resumed.feeds.length).toBe(15);
      expect(resumed.feeds[0]!.sequence).toBe(full.feeds[10]!.sequence);
      expect(resumed.feeds.at(-1)!.sequence).toBe(24);
    } finally {
      await mock.close();
    }
  });

  it("honors the requested time window", async () => {
    const rows = makeRows(25);
    const mock = await startMockSamsara({ token: "t", rows, pageSize: 100 });
    try {
      const client = new SamsaraClient({ baseUrl: mock.url, token: "t" });
      const { feeds } = await client.backfill(rows[5]!.time, rows[15]!.time);
      expect(feeds.length).toBe(11); // indices 5..15 inclusive
      expect(feeds[0]!.sequence).toBe(5);
    } finally {
      await mock.close();
    }
  });

  it("maps a row into the shared envelope with latency-derived confidence", () => {
    const env = toEnvelope(makeRows(1)[0]!);
    expect(env.feedType).toBe("movement");
    expect(env.provenance).toBe("real");
    expect(env.payload.assetId).toBe("TRK-1");
    expect(env.quality.latencyMinutes).toBe(2);
    expect(env.quality.confidence).toBeGreaterThan(0.98);
  });
});
