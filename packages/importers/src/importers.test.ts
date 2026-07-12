import { describe, it, expect } from "vitest";
import type { AnyFeedMessage } from "@rally/domain";
import { ingestFeedBatch, validateEnvelope, fromTelematicsRow, fromWmsRow, resetAdapterState } from "./index.js";

describe("importers — the real-feed seam", () => {
  it("rejects malformed envelopes", () => {
    expect(validateEnvelope(null)).not.toBeNull();
    expect(validateEnvelope({ feedId: "x" })).not.toBeNull();
  });

  it("detects sequence gaps and duplicates per source", () => {
    const mk = (seq: number): AnyFeedMessage => ({
      feedId: "mov-TRK1",
      feedType: "movement",
      sequence: seq,
      emittedAt: new Date(Date.UTC(2026, 0, 1, seq)).toISOString(),
      ingestedAt: new Date(Date.UTC(2026, 0, 1, seq)).toISOString(),
      provenance: "real",
      quality: { latencyMinutes: 0, confidence: 1 },
      payload: { assetId: "TRK1", ts: "", location: { lat: 0, lon: 0 }, speedMph: 0, headingDeg: 0 },
    });
    // seq 1,2,4,4 → one gap (3 missing) + one duplicate
    const { issues } = ingestFeedBatch([mk(1), mk(2), mk(4), mk(4)]);
    expect(issues.some((i) => i.kind === "gap")).toBe(true);
    expect(issues.some((i) => i.kind === "duplicate")).toBe(true);
  });

  it("maps a vendor telematics row into the shared envelope", () => {
    resetAdapterState();
    const env = fromTelematicsRow({
      assetId: "TRK-9", timestamp: "2026-01-01T00:00:00.000Z", lat: 32.7, lon: -96.8,
      speedMph: 55, headingDeg: 180, shipmentRef: "SHIP-1", receivedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(env.feedType).toBe("movement");
    expect(env.provenance).toBe("real");
    expect(env.quality.latencyMinutes).toBe(5);
    expect(env.payload.shipmentRef).toBe("SHIP-1");
    expect(validateEnvelope(env)).toBeNull();
  });

  it("maps a WMS row into the shared envelope", () => {
    resetAdapterState();
    const env = fromWmsRow({ facilityId: "DC_DAL", timestamp: "2026-01-01T00:00:00.000Z", type: "receipt", skuId: "SKU_COLA", quantityUnits: 500 });
    expect(env.feedType).toBe("warehouse");
    expect(env.payload.type).toBe("receipt");
    expect(validateEnvelope(env)).toBeNull();
  });
});
