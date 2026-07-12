/**
 * Feed emitter — the synthetic side of the single ingestion seam.
 *
 * It sheds the same FeedEnvelope shapes a real telematics / WMS / ERP export
 * would, complete with lag, missing shipment refs, and sequence gaps, so the
 * state estimator has real problems to solve. Swapping to a real source later is
 * a data-source change behind this identical envelope — nothing downstream moves.
 */

import type {
  AdvanceShipNotice,
  AnyFeedMessage,
  FeedEnvelope,
  GeoPoint,
  InventorySnapshot,
  MovementEvent,
  WarehouseEvent,
} from "@rally/domain";
import { hourToIso } from "./time.js";
import type { SimWorld } from "./types.js";

const SNAPSHOT_INTERVAL_HOURS = 12;
const MISSING_REF_PROB = 0.2; // movement pings that arrive without a shipmentRef
const GAP_PROB = 0.05; // dropped movement pings that leave a sequence gap

function nextSeq(world: SimWorld, feedId: string): number {
  const n = (world.feedSeq.get(feedId) ?? 0) + 1;
  world.feedSeq.set(feedId, n);
  return n;
}

function lerp(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

function locate(world: SimWorld, id: string): GeoPoint {
  const f = world.config.network.facilities.find((x) => x.facilityId === id);
  if (f) return f.location;
  const c = world.config.network.customers.find((x) => x.customerId === id);
  return c?.location ?? { lat: 0, lon: 0 };
}

function envelope<T>(
  world: SimWorld,
  feedId: string,
  feedType: FeedEnvelope<T>["feedType"],
  emitHour: number,
  latencyMinutes: number,
  confidence: number,
  payload: T,
): FeedEnvelope<T> {
  return {
    feedId,
    feedType,
    sequence: nextSeq(world, feedId),
    emittedAt: hourToIso(emitHour),
    ingestedAt: new Date(new Date(hourToIso(emitHour)).getTime() + latencyMinutes * 60_000).toISOString(),
    provenance: "synthetic",
    quality: { latencyMinutes, confidence },
    payload,
  };
}

export function emitFeedsForHour(world: SimWorld): void {
  const sink = world.feedSink;
  if (!sink) return;
  const h = world.hour;
  const rng = world.rng;

  // --- Movement feed: one ping per in-transit inbound truck. ---
  for (const s of world.shipments) {
    if (s.kind === "customer") continue;
    if (s.status !== "in_transit") continue;
    let assetId = world.assetOf.get(s.shipmentId);
    if (!assetId) {
      assetId = `TRK-${1000 + world.seq.asset++}`;
      world.assetOf.set(s.shipmentId, assetId);
    }
    const feedId = `mov-${assetId}`;
    const dep = s.departedAtHour ?? h;
    const frac = s.etaHour > dep ? Math.min(1, Math.max(0, (h - dep) / (s.etaHour - dep))) : 1;
    const loc = lerp(locate(world, s.originId), locate(world, s.destId), frac);

    // A dropped ping still burns a sequence number → the estimator sees a gap.
    if (rng.chance(GAP_PROB)) {
      nextSeq(world, feedId);
      continue;
    }
    const withRef = !rng.chance(MISSING_REF_PROB);
    const payload: MovementEvent = {
      assetId,
      ...(withRef ? { shipmentRef: s.shipmentId } : {}),
      ts: hourToIso(h),
      location: loc,
      speedMph: frac >= 1 ? 0 : rng.int(45, 62),
      headingDeg: rng.int(0, 359),
      ...(frac >= 1 ? { geofenceId: s.destId, geofenceTransition: "enter" as const } : {}),
      ...(h === dep ? { geofenceId: s.originId, geofenceTransition: "exit" as const } : {}),
    };
    sink.push(envelope(world, feedId, "movement", h, rng.int(0, 15), rng.float(0.85, 1), payload));
  }

  // --- Warehouse feed: this hour's WMS transactions. ---
  for (const p of world.txn.picks) {
    const payload: WarehouseEvent = {
      facilityId: p.facilityId,
      ts: hourToIso(h),
      type: "pick",
      skuId: p.skuId,
      quantityUnits: Math.round(p.qty),
    };
    sink.push(envelope(world, `wms-${p.facilityId}`, "warehouse", h, rng.int(0, 8), rng.float(0.9, 1), payload));
  }
  for (const r of world.txn.receipts) {
    const payload: WarehouseEvent = {
      facilityId: r.facilityId,
      ts: hourToIso(h),
      type: "receipt",
      skuId: r.skuId,
      quantityUnits: Math.round(r.qty),
      ...(r.shipmentRef ? { shipmentRef: r.shipmentRef } : {}),
    };
    sink.push(envelope(world, `wms-${r.facilityId}`, "warehouse", h, rng.int(0, 8), rng.float(0.9, 1), payload));
  }
  for (const sc of world.txn.shipConfirms) {
    const payload: WarehouseEvent = {
      facilityId: sc.facilityId,
      ts: hourToIso(h),
      type: "ship_confirm",
      skuId: sc.skuId,
      quantityUnits: Math.round(sc.qty),
      shipmentRef: sc.shipmentRef,
    };
    sink.push(envelope(world, `wms-${sc.facilityId}`, "warehouse", h, rng.int(0, 8), rng.float(0.9, 1), payload));
  }

  // --- ASN feed: an EDI 856 per dispatch, from the shipping origin. ---
  for (const a of world.txn.asns) {
    const payload: AdvanceShipNotice = {
      shipmentRef: a.shipmentRef,
      originId: a.originId,
      destId: a.destId,
      skuId: a.skuId,
      quantityUnits: a.qty,
      shippedAt: hourToIso(h),
      expectedArrivalAt: hourToIso(a.etaHour),
    };
    // EDI can lag; the shipper's notice sometimes arrives after the truck rolls.
    sink.push(envelope(world, `asn-${a.originId}`, "asn", h, rng.int(0, 45), rng.float(0.9, 1), payload));
  }

  // --- Inventory feed: periodic, lagging on-hand extract per facility. ---
  if (h % SNAPSHOT_INTERVAL_HOURS === 0) {
    const byFacility = new Map<string, InventorySnapshot>();
    for (const cell of world.positions.values()) {
      let snap = byFacility.get(cell.facilityId);
      if (!snap) {
        snap = { facilityId: cell.facilityId, ts: hourToIso(h), positions: [] };
        byFacility.set(cell.facilityId, snap);
      }
      const onHand = Math.round(cell.onHandUnits);
      const allocated = Math.round(cell.allocatedUnits);
      snap.positions.push({ skuId: cell.skuId, onHandUnits: onHand, allocatedUnits: allocated, availableUnits: Math.max(0, onHand - allocated) });
    }
    for (const [facilityId, snap] of byFacility) {
      // Deliberately lagging: the extract lands 30–120 min after it was cut.
      sink.push(envelope(world, `inv-${facilityId}`, "inventory_snapshot", h, rng.int(30, 120), 1, snap));
    }
  }
}
