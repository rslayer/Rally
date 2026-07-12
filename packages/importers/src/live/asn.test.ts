import { describe, it, expect } from "vitest";
import { AsnClient, asnToEnvelope, startMockAsn, type AsnRow } from "../index.js";

const BASE = Date.UTC(2026, 0, 5, 0, 0, 0);
function makeRows(n: number): AsnRow[] {
  return Array.from({ length: n }, (_, i) => ({
    sequence: i,
    time: new Date(BASE + i * 60_000).toISOString(),
    receivedAt: new Date(BASE + i * 60_000 + 90_000).toISOString(),
    shipmentRef: `SHIP-${i}`,
    originId: "PLANT_DAL",
    destId: "DC_HOU",
    sku: "SKU_COLA",
    qty: 500 + i,
    expectedArrival: new Date(BASE + i * 60_000 + 26 * 3_600_000).toISOString(),
  }));
}
const START = new Date(BASE).toISOString();
const END = new Date(BASE + 60 * 60_000).toISOString();

describe("AsnClient (EDI-856 connector)", () => {
  it("pages advance ship notices into asn envelopes with dest + qty", async () => {
    const mock = await startMockAsn({ token: "t", rows: makeRows(25), pageSize: 10 });
    try {
      const client = new AsnClient({ baseUrl: mock.url, token: "t", pageLimit: 10 });
      const { feeds, stats } = await client.backfill(START, END);
      expect(feeds.length).toBe(25);
      expect(stats.pages).toBe(3);
      expect(feeds.every((f) => f.feedType === "asn")).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("maps an ASN row into a notice that declares the destination up front", () => {
    const env = asnToEnvelope(makeRows(1)[0]!);
    expect(env.feedType).toBe("asn");
    expect(env.payload.destId).toBe("DC_HOU"); // the piece a ship-confirm lacks
    expect(env.payload.quantityUnits).toBe(500);
    expect(env.payload.expectedArrivalAt).toBeTruthy();
    expect(env.provenance).toBe("real");
  });
});
