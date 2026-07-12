/**
 * Inventory kernel — the closed loop.
 *
 * Demand draws inventory down every tick. Low projected inventory triggers a
 * replenishment. Replenishment mutates future state. Outcomes are measured.
 * This is the loop the current-generation "visibility dashboard" never closes.
 */

import type {
  Exception,
  Order,
  ProductionRun,
  ScenarioState,
  Shipment,
  StockoutRisk,
} from "@rally/domain";
import { forecastMultiplier, demandKey, lane } from "@rally/data-gen";
import { demandMultiplier, facilityFrozen } from "./apply.js";
import { projectCell } from "./projection.js";
import { cellKey, available, getCell } from "./kernel-util.js";
import { REORDER_REVIEW_HOURS, laneLeadHours } from "./lead.js";
import type { DemandBucket, PositionCell, RunMetrics, SimConfig, SimWorld } from "./types.js";
import { DC_IDS, PLANT_ID } from "@rally/data-gen";

const PRODUCTION_LEAD_HOURS = 6;
const CUSTOMER_TRANSIT_HOURS = 1;
const RISK_HORIZON_HOURS = 72;
/** Ignore thin projected crossings — within-policy horizon-edge noise. */
const MATERIALITY_UNITS = 150;
/** Re-fire a cell's risk when its shortfall worsens by this factor. */
const RISK_REFIRE_FACTOR = 1.6;

function emptyMetrics(): RunMetrics {
  return {
    demandUnits: 0,
    servedUnits: 0,
    unmetUnits: 0,
    stockoutHours: 0,
    actionCost: 0,
    ordersCreated: 0,
    ordersDelivered: 0,
    ordersBackordered: 0,
    shipmentsCreated: 0,
    shipmentsDelivered: 0,
    shipmentsMissed: 0,
  };
}

export function initWorld(config: SimConfig, rng: SimWorld["rng"]): SimWorld {
  const { network, demandModel, cover } = config;
  const positions = new Map<string, PositionCell>();
  const buckets = new Map<string, DemandBucket>();

  // DC cells sized from demand cover targets.
  for (const dc of DC_IDS) {
    for (const sku of network.skus) {
      const daily = demandModel.baseDaily[demandKey(dc, sku.skuId)] ?? 0;
      const hourly = daily / 24;
      positions.set(cellKey(dc, sku.skuId), {
        facilityId: dc,
        skuId: sku.skuId,
        onHandUnits: Math.round(daily * cover.initialDays),
        allocatedUnits: 0,
        reorderPointUnits: Math.round(daily * cover.reorderDays),
        orderUpToUnits: Math.round(daily * cover.orderUpToDays),
        hourlyDemand: hourly,
      });
      buckets.set(cellKey(dc, sku.skuId), {
        startHour: 0,
        demandUnits: 0,
        servedUnits: 0,
        unmetUnits: 0,
      });
    }
  }

  // Plant cells: fed by production runs, drained by replenishment.
  const production: ProductionRun[] = [];
  let runSeq = 0;
  for (const sku of network.skus) {
    const networkDaily = DC_IDS.reduce(
      (s, dc) => s + (demandModel.baseDaily[demandKey(dc, sku.skuId)] ?? 0),
      0,
    );
    positions.set(cellKey(PLANT_ID, sku.skuId), {
      facilityId: PLANT_ID,
      skuId: sku.skuId,
      onHandUnits: Math.round(networkDaily * 3),
      allocatedUnits: 0,
      reorderPointUnits: Math.round(networkDaily * 2),
      orderUpToUnits: Math.round(networkDaily * 6),
      hourlyDemand: 0,
    });
    // Pre-schedule a daily production run per SKU across the horizon so the
    // resolver has real runs to pull forward.
    for (let start = 12; start < config.horizonHours; start += 24) {
      production.push({
        runId: `RUN-${sku.skuId}-${runSeq++}`,
        facilityId: PLANT_ID,
        skuId: sku.skuId,
        quantityUnits: sku.unitsPerRun,
        scheduledStartHour: start,
        completesAtHour: start + PRODUCTION_LEAD_HOURS,
        status: "scheduled",
        confidence: 1,
      });
    }
  }

  return {
    config,
    rng,
    hour: 0,
    positions,
    shipments: [],
    orders: [],
    production,
    buckets,
    exceptions: [],
    risks: [],
    decisions: [],
    metrics: emptyMetrics(),
    txn: { picks: [], receipts: [], shipConfirms: [], asns: [] },
    seenRiskKeys: new Map(),
    seq: { shipment: 0, order: 0, run: runSeq, exc: 0, risk: 0, asset: 0 },
    feedSink: config.emitFeeds ? [] : undefined,
    feedSeq: new Map(),
    assetOf: new Map(),
    pendingShort: new Map(),
  };
}

/* --------------------------- disruption onset --------------------------- */

export function applyDisruptionOnset(world: SimWorld): void {
  const h = world.hour;
  for (const d of world.config.disruptions) {
    if (d.startHour !== h) continue;
    switch (d.type) {
      case "inbound_delay": {
        // Delay the next in-transit replenishment to this DC/SKU.
        const target = world.shipments.find(
          (s) =>
            s.kind !== "customer" &&
            s.destId === d.facilityId &&
            s.skuId === d.skuId &&
            (s.status === "in_transit" || s.status === "planned"),
        );
        if (target) {
          target.etaHour += Math.round(d.magnitude);
          d.targetRef = target.shipmentId;
        }
        break;
      }
      case "supply_shortfall": {
        // The supplier short-ships this DC's replenishment for the window, so
        // the DC's inbound arrives light and its projection sees the gap.
        world.pendingShort.set(cellKey(d.facilityId, d.skuId), {
          fraction: d.magnitude,
          untilHour: d.startHour + d.durationHours,
        });
        break;
      }
      case "quality_hold": {
        // Quarantine the SKU network-wide: available drops to zero everywhere.
        for (const cell of world.positions.values()) {
          if (cell.skuId === d.skuId) {
            cell.allocatedUnits = cell.onHandUnits; // available := 0
          }
        }
        break;
      }
      // demand_spike + labor_action are continuous, read each tick.
      case "demand_spike":
      case "labor_action":
        break;
    }
  }
}

/* ------------------------------ production ------------------------------ */

export function runProduction(world: SimWorld): void {
  const h = world.hour;
  for (const run of world.production) {
    if (run.status === "scheduled" && run.scheduledStartHour === h) run.status = "running";
    if ((run.status === "running" || run.status === "scheduled") && run.completesAtHour === h) {
      const cell = getCell(world, run.facilityId, run.skuId);
      if (cell) cell.onHandUnits += run.quantityUnits;
      run.status = "complete";
      world.txn.receipts.push({ facilityId: run.facilityId, skuId: run.skuId, qty: run.quantityUnits, shipmentRef: run.runId });
    }
  }
}

/* ------------------------------ shipments ------------------------------ */

export function advanceShipments(world: SimWorld): void {
  const h = world.hour;
  for (const s of world.shipments) {
    if (s.status === "planned" && s.departedAtHour !== undefined && s.departedAtHour <= h) {
      s.status = "in_transit";
    }
    if (s.status === "in_transit" && s.etaHour <= h) {
      // A frozen destination cannot receive — the load waits at the door.
      if (facilityFrozen(world.config.disruptions, s.destId, h)) continue;
      s.status = "delivered";
      s.deliveredAtHour = h;
      world.metrics.shipmentsDelivered++;
      if (s.kind === "customer") {
        completeCustomerOrder(world, s);
      } else {
        const cell = getCell(world, s.destId, s.skuId);
        if (cell) cell.onHandUnits += s.quantityUnits;
        world.txn.receipts.push({ facilityId: s.destId, skuId: s.skuId, qty: s.quantityUnits, shipmentRef: s.shipmentId });
      }
    }
  }
}

function completeCustomerOrder(world: SimWorld, shipment: Shipment): void {
  if (!shipment.orderId) return;
  const order = world.orders.find((o) => o.orderId === shipment.orderId);
  if (!order) return;
  // An order is delivered only via ITS OWN shipment, and only if fully served.
  if (order.backorderedUnits === 0) {
    order.status = "delivered";
    world.metrics.ordersDelivered++;
  } else {
    order.status = "backordered";
  }
}

/* -------------------------------- demand -------------------------------- */

export function applyDemand(world: SimWorld): void {
  const h = world.hour;
  const { disruptions } = world.config;
  for (const dc of DC_IDS) {
    const frozen = facilityFrozen(disruptions, dc, h);
    for (const sku of world.config.network.skus) {
      const cell = getCell(world, dc, sku.skuId)!;
      const rate =
        cell.hourlyDemand * forecastMultiplier(h) * demandMultiplier(disruptions, dc, sku.skuId, h);
      if (rate <= 0) continue;
      const avail = frozen ? 0 : available(cell); // frozen DC cannot pick
      const served = Math.min(rate, avail);
      const unmet = rate - served;
      cell.onHandUnits -= served;
      if (served > 0) world.txn.picks.push({ facilityId: dc, skuId: sku.skuId, qty: served });

      world.metrics.demandUnits += rate;
      world.metrics.servedUnits += served;
      world.metrics.unmetUnits += unmet;
      if (unmet > 1e-6) world.metrics.stockoutHours += 1;

      const bucket = world.buckets.get(cellKey(dc, sku.skuId))!;
      bucket.demandUnits += rate;
      bucket.servedUnits += served;
      bucket.unmetUnits += unmet;
    }
  }
}

/* ---------------------------- order buckets ---------------------------- */

export function closeBuckets(world: SimWorld): void {
  const h = world.hour;
  const bucketHours = world.config.orderBucketHours;
  if ((h + 1) % bucketHours !== 0) return; // close at the end of each bucket window

  for (const dc of DC_IDS) {
    const customer = world.config.network.customers.find((c) => c.servedByFacilityId === dc);
    for (const sku of world.config.network.skus) {
      const key = cellKey(dc, sku.skuId);
      const bucket = world.buckets.get(key)!;
      if (bucket.demandUnits < 1) {
        resetBucket(bucket, h + 1);
        continue;
      }
      const orderId = `ORD-${world.seq.order++}`;
      const shippedUnits = Math.round(bucket.servedUnits);
      const backordered = Math.max(0, Math.round(bucket.demandUnits - bucket.servedUnits));
      const order: Order = {
        orderId,
        customerId: customer?.customerId ?? `CUST_${dc}`,
        skuId: sku.skuId,
        quantityUnits: Math.round(bucket.demandUnits),
        requestedByHour: h + 1 + world.config.orderBucketHours,
        status: backordered > 0 ? "backordered" : "allocated",
        backorderedUnits: backordered,
        confidence: 1,
      };
      world.metrics.ordersCreated++;
      if (backordered > 0) world.metrics.ordersBackordered++;

      // The order's own shipment carries exactly the served units.
      if (shippedUnits > 0) {
        const shipmentId = `SHIP-${world.seq.shipment++}`;
        order.allocatedShipmentId = shipmentId;
        order.status = backordered > 0 ? "backordered" : "shipped";
        const ship: Shipment = {
          shipmentId,
          kind: "customer",
          laneId: `${dc}->${order.customerId}`,
          originId: dc,
          destId: order.customerId,
          skuId: sku.skuId,
          quantityUnits: shippedUnits,
          orderId,
          status: "in_transit",
          departedAtHour: h + 1,
          etaHour: h + 1 + CUSTOMER_TRANSIT_HOURS,
          expedited: false,
          confidence: 1,
        };
        world.shipments.push(ship);
        world.metrics.shipmentsCreated++;
        world.txn.shipConfirms.push({ facilityId: dc, skuId: sku.skuId, qty: shippedUnits, shipmentRef: shipmentId });
      }
      world.orders.push(order);

      if (backordered > 0) {
        pushException(world, {
          type: "order_at_risk",
          facilityId: dc,
          skuId: sku.skuId,
          orderId,
          detail: `${backordered} units backordered of ${order.quantityUnits} on ${sku.skuId} at ${dc}`,
          confidence: 1,
        });
        world.metrics.shipmentsMissed += 1;
      }
      resetBucket(bucket, h + 1);
    }
  }
}

function resetBucket(b: DemandBucket, startHour: number): void {
  b.startHour = startHour;
  b.demandUnits = 0;
  b.servedUnits = 0;
  b.unmetUnits = 0;
}

/* ---------------------------- replenishment ---------------------------- */

export function runReplenishment(world: SimWorld): void {
  const h = world.hour;
  if (h % REORDER_REVIEW_HOURS !== 0) return; // periodic review policy
  const net = world.config.network;

  // DC replenishment from the plant.
  for (const dc of DC_IDS) {
    for (const sku of net.skus) {
      const cell = getCell(world, dc, sku.skuId)!;
      const pipeline = inboundPipeline(world, dc, sku.skuId);
      const position = available(cell) + pipeline;
      if (position > cell.reorderPointUnits) continue;
      const orderQty = Math.round(cell.orderUpToUnits - position);
      if (orderQty <= 0) continue;
      createReplenishment(world, PLANT_ID, dc, sku.skuId, orderQty, false);
    }
  }

  // Plant replenishment from production (schedule an extra run if low).
  for (const sku of net.skus) {
    const cell = getCell(world, PLANT_ID, sku.skuId)!;
    const scheduledSoon = world.production.some(
      (r) => r.skuId === sku.skuId && r.status !== "complete" && r.status !== "cancelled" && r.completesAtHour <= h + REORDER_REVIEW_HOURS,
    );
    if (available(cell) <= cell.reorderPointUnits && !scheduledSoon) {
      world.production.push({
        runId: `RUN-${sku.skuId}-${world.seq.run++}`,
        facilityId: PLANT_ID,
        skuId: sku.skuId,
        quantityUnits: sku.unitsPerRun,
        scheduledStartHour: h,
        completesAtHour: h + PRODUCTION_LEAD_HOURS,
        status: "scheduled",
        confidence: 1,
      });
    }
  }
}

export function inboundPipeline(world: SimWorld, facilityId: string, skuId: string): number {
  let sum = 0;
  for (const s of world.shipments) {
    if (s.destId === facilityId && s.skuId === skuId && s.kind !== "customer") {
      if (s.status === "planned" || s.status === "in_transit") sum += s.quantityUnits;
    }
  }
  return sum;
}

/** Create a replenishment/transfer shipment, drawing from the origin's on-hand. */
export function createReplenishment(
  world: SimWorld,
  originId: string,
  destId: string,
  skuId: string,
  requestedQty: number,
  expedited: boolean,
): Shipment | undefined {
  const ln = lane(world.config.network, originId, destId);
  if (!ln) return undefined;
  const originCell = getCell(world, originId, skuId);
  if (!originCell) return undefined;
  let qty = Math.min(requestedQty, available(originCell));
  // Supplier short-ship: plant replenishment into a constrained DC arrives light.
  if (originId === PLANT_ID) {
    const short = world.pendingShort.get(cellKey(destId, skuId));
    if (short && world.hour < short.untilHour) qty = Math.round(qty * (1 - short.fraction));
  }
  if (qty <= 0) return undefined;

  originCell.onHandUnits -= qty; // picked & shipped now
  // Log the origin draw-down so the estimator can roll this facility forward too.
  world.txn.picks.push({ facilityId: originId, skuId, qty });
  const transit = expedited && ln.expeditedTransitHours ? ln.expeditedTransitHours : ln.transitHours;
  const kind = originId === PLANT_ID ? "replenishment" : "transfer";
  const ship: Shipment = {
    shipmentId: `SHIP-${world.seq.shipment++}`,
    kind,
    laneId: ln.laneId,
    originId,
    destId,
    skuId,
    quantityUnits: qty,
    status: "in_transit",
    departedAtHour: world.hour,
    etaHour: world.hour + laneLeadHours(transit, expedited),
    expedited,
    confidence: 1,
  };
  world.shipments.push(ship);
  world.metrics.shipmentsCreated++;
  // Dispatch record: a WMS ship-confirm at origin carrying the shipmentRef, sku,
  // and qty. Joined to the truck's movement pings (which carry the destination)
  // by shipmentRef, this lets the estimator reconstruct in-flight inbound.
  world.txn.shipConfirms.push({ facilityId: originId, skuId, qty, shipmentRef: ship.shipmentId });
  // Advance ship notice (EDI 856): the shipper declares dest + qty + ETA up
  // front, so inbound is visible without joining telematics for a destination.
  world.txn.asns.push({ shipmentRef: ship.shipmentId, originId, destId, skuId, qty, etaHour: ship.etaHour });
  return ship;
}

/* ------------------------- risk / exception ---------------------------- */

export function detectRisks(world: SimWorld): StockoutRisk[] {
  const h = world.hour;
  const fresh: StockoutRisk[] = [];
  for (const dc of DC_IDS) {
    const frozen = facilityFrozen(world.config.disruptions, dc, h);
    for (const sku of world.config.network.skus) {
      // A frozen dock causes a service miss WITHOUT depleting on-hand, so the
      // stockout projection is blind to it. Surface it directly as a risk (which
      // the resolver will escalate) rather than let it become a silent miss.
      if (frozen) {
        const cell = getCell(world, dc, sku.skuId);
        const laborKey = `LAB|${dc}|${sku.skuId}`;
        if (cell && cell.hourlyDemand > 0 && !world.seenRiskKeys.has(laborKey)) {
          world.seenRiskKeys.set(laborKey, 1);
          const risk: StockoutRisk = {
            riskId: `RISK-${world.seq.risk++}`,
            facilityId: dc,
            skuId: sku.skuId,
            detectedAtHour: h,
            hoursToStockout: 0,
            projectedShortfallUnits: Math.round(cell.hourlyDemand * 24),
            confidence: 0.9,
            drivers: [`receiving/throughput suspended at ${dc}`],
          };
          world.risks.push(risk);
          fresh.push(risk);
          pushException(world, {
            type: "order_at_risk",
            facilityId: dc,
            skuId: sku.skuId,
            detail: `throughput suspended at ${dc} — service at risk for ${sku.skuId}`,
            confidence: 0.9,
          });
        }
        continue; // don't also run stockout projection for a frozen cell
      }
      const proj = projectCell(world, dc, sku.skuId, h, RISK_HORIZON_HOURS);
      const key = `${dc}|${sku.skuId}`;
      if (!proj.crosses || proj.shortfallUnits < MATERIALITY_UNITS) {
        if (!proj.crosses) world.seenRiskKeys.delete(key); // reset so a re-cross re-fires
        continue;
      }
      // Edge-triggered, but re-fire if the risk has materially WORSENED — so a
      // spike landing after a marginal risk is re-evaluated, not suppressed.
      const lastShortfall = world.seenRiskKeys.get(key);
      if (lastShortfall !== undefined && proj.shortfallUnits < lastShortfall * RISK_REFIRE_FACTOR) continue;
      world.seenRiskKeys.set(key, proj.shortfallUnits);

      const drivers = describeDrivers(world, dc, sku.skuId, h);
      const confidence = riskConfidence(world, proj.hoursToStockout);
      const risk: StockoutRisk = {
        riskId: `RISK-${world.seq.risk++}`,
        facilityId: dc,
        skuId: sku.skuId,
        detectedAtHour: h,
        hoursToStockout: proj.hoursToStockout,
        projectedShortfallUnits: proj.shortfallUnits,
        confidence,
        drivers,
      };
      world.risks.push(risk);
      fresh.push(risk);
      pushException(world, {
        type: "projected_stockout",
        facilityId: dc,
        skuId: sku.skuId,
        detail: `available projected to cross zero in ${proj.hoursToStockout}h (shortfall ~${proj.shortfallUnits}u): ${drivers.join(", ")}`,
        confidence,
      });
    }
  }
  return fresh;
}

/**
 * Confidence attached to a detected risk. Blends the state-estimate fidelity
 * story with signal clarity: an imminent, sharply-projected crossing is a clear
 * signal (high confidence); a marginal crossing at the far edge of the horizon
 * is uncertain (low confidence) and should bias toward escalation. A small
 * seeded jitter keeps the calibration curve from being a hard step.
 */
function riskConfidence(world: SimWorld, hoursToStockout: number): number {
  const ratio = Math.min(1, hoursToStockout / (RISK_HORIZON_HOURS * 1.5));
  const margin = 1 - ratio; // imminent → near 1, far-edge → near 0
  const jitter = (world.rng.next() - 0.5) * 0.1;
  return Math.max(0.3, Math.min(0.98, 0.45 + 0.5 * margin + jitter));
}

function describeDrivers(world: SimWorld, dc: string, skuId: string, h: number): string[] {
  const drivers: string[] = [];
  for (const d of world.config.disruptions) {
    if (!(h >= d.startHour && h < d.startHour + d.durationHours + 72)) continue;
    if (d.facilityId !== dc && d.skuId !== skuId) continue;
    if (d.type === "demand_spike" && d.facilityId === dc && d.skuId === skuId) {
      drivers.push(`demand +${Math.round((d.magnitude - 1) * 100)}%`);
    } else if (d.type === "inbound_delay" && d.facilityId === dc) {
      drivers.push(`late inbound +${Math.round(d.magnitude)}h`);
    } else if (d.type === "supply_shortfall" && d.skuId === skuId) {
      drivers.push(`supply cut ${Math.round(d.magnitude * 100)}%`);
    } else if (d.type === "labor_action" && d.facilityId === dc) {
      drivers.push(`labor action at ${dc}`);
    } else if (d.type === "quality_hold" && d.skuId === skuId) {
      drivers.push(`quality hold on ${skuId}`);
    }
  }
  if (drivers.length === 0) drivers.push("baseline demand outpacing cover");
  return drivers;
}

export function pushException(world: SimWorld, e: Omit<Exception, "exceptionId" | "hour">): void {
  world.exceptions.push({ exceptionId: `EXC-${world.seq.exc++}`, hour: world.hour, ...e });
}

/* ------------------------------ snapshot ------------------------------- */

export function snapshot(world: SimWorld): ScenarioState {
  const positions = [...world.positions.values()].map((c) => ({
    facilityId: c.facilityId,
    skuId: c.skuId,
    onHandUnits: Math.round(c.onHandUnits),
    allocatedUnits: Math.round(c.allocatedUnits),
    availableUnits: Math.round(available(c)),
    reorderPointUnits: c.reorderPointUnits,
    confidence: 1,
  }));
  return {
    networkId: world.config.network.networkId,
    hour: world.hour,
    positions,
    shipments: world.shipments.map((s) => ({ ...s })),
    orders: world.orders.map((o) => ({ ...o })),
    production: world.production.map((p) => ({ ...p })),
    assets: [],
    overallConfidence: 1,
  };
}

export { RISK_HORIZON_HOURS, CUSTOMER_TRANSIT_HOURS, MATERIALITY_UNITS };
