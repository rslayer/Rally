import { describe, it, expect } from "vitest";
import { WmsClient, wmsToEnvelope, startMockWms, HttpError, type WmsTxnRow } from "../index.js";

const BASE = Date.UTC(2026, 0, 5, 0, 0, 0);
const TYPES = ["receipt", "pick", "ship_confirm", "adjustment"] as const;

function makeRows(n: number): WmsTxnRow[] {
  return Array.from({ length: n }, (_, i) => ({
    sequence: i,
    time: new Date(BASE + i * 60_000).toISOString(),
    receivedAt: new Date(BASE + i * 60_000 + 60_000).toISOString(),
    facilityId: "DC_DAL",
    type: TYPES[i % TYPES.length]!,
    sku: "SKU_COLA",
    qty: 100 + i,
    shipmentRef: `SHIP-${i}`,
  }));
}
const START = new Date(BASE).toISOString();
const END = new Date(BASE + 60 * 60_000).toISOString();

describe("WmsClient (second connector — proves the seam generalizes)", () => {
  it("pages through warehouse transactions into warehouse envelopes", async () => {
    const mock = await startMockWms({ token: "t", rows: makeRows(25), pageSize: 10 });
    try {
      const client = new WmsClient({ baseUrl: mock.url, token: "t", pageLimit: 10 });
      const { feeds, stats } = await client.backfill(START, END);
      expect(feeds.length).toBe(25);
      expect(stats.pages).toBe(3);
      expect(feeds.every((f) => f.feedType === "warehouse")).toBe(true);
      expect(feeds[0]!.feedId).toBe("wms-DC_DAL");
    } finally {
      await mock.close();
    }
  });

  it("rejects a bad token without retrying", async () => {
    const mock = await startMockWms({ token: "right", rows: makeRows(3), pageSize: 10 });
    try {
      const client = new WmsClient({ baseUrl: mock.url, token: "wrong", maxRetries: 3 });
      await expect(client.backfill(START, END)).rejects.toBeInstanceOf(HttpError);
      expect(mock.requestCount()).toBe(1);
    } finally {
      await mock.close();
    }
  });

  it("recovers from a 429 with backoff", async () => {
    const mock = await startMockWms({ token: "t", rows: makeRows(12), pageSize: 10, injectRateLimitOnce: true });
    try {
      const client = new WmsClient({ baseUrl: mock.url, token: "t", pageLimit: 10, backoffBaseMs: 1 });
      const { feeds, stats } = await client.backfill(START, END);
      expect(feeds.length).toBe(12);
      expect(stats.rateLimitHits).toBeGreaterThanOrEqual(1);
    } finally {
      await mock.close();
    }
  });

  it("maps a transaction row into a warehouse event with quantity + type", () => {
    const env = wmsToEnvelope({ sequence: 1, time: new Date(BASE).toISOString(), receivedAt: new Date(BASE + 60_000).toISOString(), facilityId: "DC_HOU", type: "receipt", sku: "SKU_CHIP", qty: 500 });
    expect(env.feedType).toBe("warehouse");
    expect(env.payload.type).toBe("receipt");
    expect(env.payload.skuId).toBe("SKU_CHIP");
    expect(env.payload.quantityUnits).toBe(500);
    expect(env.provenance).toBe("real");
  });

  it("coerces an unknown vendor transaction code to 'adjustment'", () => {
    const env = wmsToEnvelope({ sequence: 1, time: new Date(BASE).toISOString(), receivedAt: new Date(BASE).toISOString(), facilityId: "DC_HOU", type: "weird_vendor_code", qty: 1 });
    expect(env.payload.type).toBe("adjustment");
  });
});
