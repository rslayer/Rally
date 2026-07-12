/**
 * Phase 2 — state estimator.
 *
 * Consumes the merged, time-ordered feed stream and estimates the canonical
 * ScenarioState at a target hour. It owns the three problems that separate this
 * from a dashboard:
 *
 *   • Association  — bind movement pings to shipments when shipmentRef is
 *     missing, via same-asset propagation and geofence/lane geography.
 *   • Gap & lateness — sequence gaps and stale snapshots are first-class; the
 *     affected state gets reduced confidence rather than being dropped.
 *   • Interpolation — between lagging inventory snapshots, roll on-hand forward
 *     from the warehouse event stream and record drift against the next anchor.
 *
 * Output is a ScenarioState plus per-entity confidence, so every downstream
 * consumer (decision engine, UI) reads estimated state through the same shape.
 */

import type {
  AnyFeedMessage,
  AssetTrack,
  FeedEnvelope,
  GeoPoint,
  InventorySnapshot,
  MovementEvent,
  Network,
  ScenarioState,
  Shipment,
  WarehouseEvent,
} from "@rally/domain";
import { haversineMiles, isMovement, isWarehouse, isInventorySnapshot, lane } from "@rally/domain";
import { isoToHour } from "./time.js";
import { laneLeadHours } from "./lead.js";

export interface DriftReport {
  perCell: Record<string, number>; // abs unit drift at the latest reconciled snapshot
  meanAbs: number;
  maxAbs: number;
}

export interface EstimateResult {
  state: ScenarioState;
  drift: DriftReport;
}

interface WhEvt {
  seq: number;
  hour: number;
  ev: WarehouseEvent;
  conf: number;
}
interface SnapEvt {
  hour: number;
  snap: InventorySnapshot;
  conf: number;
}
interface MovEvt {
  seq: number;
  hour: number;
  ev: MovementEvent;
  conf: number;
}

function cellKey(f: string, s: string): string {
  return `${f}|${s}`;
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function estimateState(
  feeds: AnyFeedMessage[],
  targetHour: number,
  net: Network,
): EstimateResult {
  // --- Bucket the stream by feed type (as it would arrive: any order). ---
  const warehouseByFacility = new Map<string, WhEvt[]>();
  const snapsByFacility = new Map<string, SnapEvt[]>();
  const movementByAsset = new Map<string, MovEvt[]>();

  for (const m of feeds) {
    const emitHour = isoToHour(m.emittedAt);
    if (emitHour > targetHour) continue; // the estimator only knows the past
    if (isWarehouse(m)) {
      const fac = m.payload.facilityId;
      push(warehouseByFacility, fac, { seq: m.sequence, hour: emitHour, ev: m.payload, conf: m.quality.confidence });
    } else if (isInventorySnapshot(m)) {
      const fac = m.payload.facilityId;
      push(snapsByFacility, fac, { hour: emitHour, snap: m.payload, conf: m.quality.confidence });
    } else if (isMovement(m)) {
      push(movementByAsset, m.payload.assetId, { seq: m.sequence, hour: emitHour, ev: m.payload, conf: m.quality.confidence });
    }
  }

  // --- Positions: anchor on latest snapshot ≤ T, roll forward, score drift. ---
  const positions: ScenarioState["positions"] = [];
  const drift: DriftReport = { perCell: {}, meanAbs: 0, maxAbs: 0 };
  const driftVals: number[] = [];
  const confidences: number[] = [];

  for (const fac of allFacilities(net)) {
    const snaps = (snapsByFacility.get(fac) ?? []).sort((a, b) => a.hour - b.hour);
    const wh = (warehouseByFacility.get(fac) ?? []).sort((a, b) => a.seq - b.seq);
    const gaps = sequenceGaps(wh.map((w) => w.seq));

    const anchor = latestAtOrBefore(snaps, targetHour);
    const anchorHour = anchor?.hour ?? 0;
    const staleness = targetHour - anchorHour;

    // Reconciliation drift: what rolling from the previous snapshot predicted vs
    // what the latest anchor actually reported.
    const prev = snaps.filter((s) => s.hour < anchorHour).slice(-1)[0];

    for (const sku of net.skus) {
      const key = cellKey(fac, sku.skuId);
      const anchorPos = anchor?.snap.positions.find((p) => p.skuId === sku.skuId);
      let onHand = anchorPos?.onHandUnits ?? 0;
      const allocated = anchorPos?.allocatedUnits ?? 0;

      // Roll on-hand forward from warehouse events after the anchor snapshot.
      onHand += rollDelta(wh, sku.skuId, anchorHour, targetHour);

      // Drift measurement at the reconciliation point (prev → anchor).
      if (prev && anchor && anchorPos) {
        const prevPos = prev.snap.positions.find((p) => p.skuId === sku.skuId);
        if (prevPos) {
          const predictedAtAnchor = prevPos.onHandUnits + rollDelta(wh, sku.skuId, prev.hour, anchorHour);
          const d = Math.abs(predictedAtAnchor - anchorPos.onHandUnits);
          drift.perCell[key] = d;
          driftVals.push(d);
        }
      }

      const conf = cellConfidence(staleness, gaps, anchor?.conf ?? 0.5);
      confidences.push(conf);
      positions.push({
        facilityId: fac,
        skuId: sku.skuId,
        onHandUnits: Math.max(0, Math.round(onHand)),
        allocatedUnits: Math.round(allocated),
        availableUnits: Math.max(0, Math.round(onHand - allocated)),
        reorderPointUnits: 0, // policy param, not sensed — filled by the engine config
        confidence: conf,
      });
    }
  }

  drift.meanAbs = driftVals.length ? driftVals.reduce((a, b) => a + b, 0) / driftVals.length : 0;
  drift.maxAbs = driftVals.length ? Math.max(...driftVals) : 0;

  // --- Join WMS dispatch/receipt records across the whole stream, so movement
  //     association can attach a quantity + SKU + dest to each in-flight truck. ---
  const shipConfirm = new Map<string, { sku?: string; qty: number; hour: number }>();
  const receipts = new Set<string>();
  for (const arr of warehouseByFacility.values()) {
    for (const w of arr) {
      const ref = w.ev.shipmentRef;
      if (!ref) continue;
      if (w.ev.type === "ship_confirm") shipConfirm.set(ref, { sku: w.ev.skuId, qty: w.ev.quantityUnits ?? 0, hour: w.hour });
      else if (w.ev.type === "receipt") receipts.add(ref);
    }
  }

  // --- Movement → shipment association + in-transit reconstruction. ---
  const { shipments, assets } = associateMovement(movementByAsset, net, { shipConfirm, receipts });

  const overall = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0.5;

  return {
    state: {
      networkId: net.networkId,
      hour: targetHour,
      positions,
      shipments,
      orders: [],
      production: [],
      assets,
      overallConfidence: Number(overall.toFixed(3)),
    },
    drift,
  };
}

/* ------------------------------- helpers ------------------------------- */

function push<T>(map: Map<string, T[]>, key: string, val: T): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

function allFacilities(net: Network): string[] {
  return net.facilities.map((f) => f.facilityId);
}

function latestAtOrBefore(snaps: SnapEvt[], hour: number): SnapEvt | undefined {
  let best: SnapEvt | undefined;
  for (const s of snaps) if (s.hour <= hour && (!best || s.hour > best.hour)) best = s;
  return best;
}

/** Net on-hand change from warehouse events with hour in (afterHour, toHour]. */
function rollDelta(wh: WhEvt[], skuId: string, afterHour: number, toHour: number): number {
  let delta = 0;
  for (const w of wh) {
    if (w.hour <= afterHour || w.hour > toHour) continue;
    if (w.ev.skuId !== skuId) continue;
    const q = w.ev.quantityUnits ?? 0;
    switch (w.ev.type) {
      case "receipt":
        delta += q;
        break;
      case "pick":
        delta -= q;
        break;
      case "adjustment":
        delta += q; // signed
        break;
      default:
        break; // pack/putaway/ship_confirm/cycle_count don't move on-hand here
    }
  }
  return delta;
}

function sequenceGaps(seqs: number[]): number {
  if (seqs.length < 2) return 0;
  const sorted = [...seqs].sort((a, b) => a - b);
  let gaps = 0;
  for (let i = 1; i < sorted.length; i++) gaps += Math.max(0, sorted[i]! - sorted[i - 1]! - 1);
  return gaps;
}

function cellConfidence(staleness: number, gaps: number, snapConf: number): number {
  const stalenessFactor = clamp(1 - staleness / 72, 0.4, 1);
  const gapFactor = clamp(1 - gaps * 0.03, 0.5, 1);
  return Number((stalenessFactor * gapFactor * snapConf).toFixed(3));
}

/* ---------------------- movement association --------------------------- */

function nearestFacility(net: Network, p: GeoPoint, exclude?: Set<string>): { id: string; miles: number } {
  let best = { id: net.facilities[0]!.facilityId, miles: Infinity };
  for (const f of net.facilities) {
    if (exclude?.has(f.facilityId)) continue;
    const d = haversineMiles(p, f.location);
    if (d < best.miles) best = { id: f.facilityId, miles: d };
  }
  return best;
}

interface Join {
  shipConfirm: Map<string, { sku?: string; qty: number; hour: number }>;
  receipts: Set<string>;
}

function associateMovement(
  movementByAsset: Map<string, MovEvt[]>,
  net: Network,
  join: Join,
): { shipments: Shipment[]; assets: AssetTrack[] } {
  const shipments: Shipment[] = [];
  const assets: AssetTrack[] = [];

  for (const [assetId, rawEvents] of movementByAsset) {
    const events = rawEvents.sort((a, b) => a.hour - b.hour);
    const last = events[events.length - 1]!;
    const gaps = sequenceGaps(events.map((e) => e.seq));

    // 1) Association: prefer a shipmentRef seen on ANY ping from this asset
    //    (same truck ⇒ same shipment); otherwise infer from geofence/lane geo.
    let shipmentRef = events.find((e) => e.ev.shipmentRef)?.ev.shipmentRef;
    const associationConf = shipmentRef ? 0.95 : 0.6;

    // Origin: an 'exit' geofence, else the facility nearest the first ping.
    const exit = events.find((e) => e.ev.geofenceTransition === "exit");
    const originId = exit?.ev.geofenceId ?? nearestFacility(net, events[0]!.ev.location).id;
    // Dest: an 'enter' geofence, else the nearest facility to the last ping that
    // isn't the origin (a truck mid-lane can sit closest to where it departed).
    const enter = events.find((e) => e.ev.geofenceTransition === "enter");
    const nearLast = nearestFacility(net, last.ev.location, new Set([originId]));
    const destId = enter?.ev.geofenceId ?? nearLast.id;

    if (!shipmentRef) shipmentRef = `est:${originId}->${destId}@${events[0]!.hour}`;

    // A receipt for this ref means the load has already landed.
    const receiptSeen = join.receipts.has(shipmentRef);
    const arrived = receiptSeen || !!enter || nearLast.miles < 5;
    const confidence = Number(clamp((arrived ? 0.9 : 0.75) * (1 - gaps * 0.04) * associationConf, 0.3, 1).toFixed(3));

    assets.push({
      assetId,
      lastSeenHour: last.hour,
      location: last.ev.location,
      ...(arrived ? { atFacilityId: destId } : {}),
      associatedShipmentId: shipmentRef,
      confidence,
    });

    // 2) Reconstruct an in-transit inbound shipment for trucks still en route,
    //    enriched with the SKU + quantity from the joined WMS ship-confirm.
    if (!arrived && originId !== destId) {
      const dispatch = join.shipConfirm.get(shipmentRef);
      const ln = lane(net, originId, destId);
      const departedAtHour = dispatch?.hour ?? events[0]!.hour;
      // Known master-data lead (transit + handling) puts the ETA in the right place.
      const etaHour = ln ? departedAtHour + laneLeadHours(ln.transitHours, false) : last.hour + 24;
      shipments.push({
        shipmentId: shipmentRef,
        kind: originId.startsWith("PLANT") ? "replenishment" : "transfer",
        laneId: `${originId}->${destId}`,
        originId,
        destId,
        skuId: dispatch?.sku ?? "unknown",
        quantityUnits: dispatch?.qty ?? 0,
        status: "in_transit",
        departedAtHour,
        etaHour,
        expedited: false,
        confidence,
      });
    }
  }

  return { shipments, assets };
}
