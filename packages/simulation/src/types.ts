/** Internal simulation world + run configuration. */

import type {
  Disruption,
  Exception,
  Network,
  Order,
  PolicyConfig,
  ProductionRun,
  ResolutionDecision,
  ScenarioState,
  Shipment,
  StockoutRisk,
} from "@rally/domain";
import type { DemandModel } from "@rally/data-gen";
import type { Rng } from "@rally/data-gen";

export interface SimConfig {
  network: Network;
  demandModel: DemandModel;
  horizonHours: number;
  seed: number;
  disruptions: Disruption[];
  policy: PolicyConfig;
  /** When false, the resolver never acts — this is the `hold` counterfactual. */
  resolverEnabled: boolean;
  /** Hours of demand aggregated into one tracked customer order. */
  orderBucketHours: number;
  /** Inventory policy cover targets, in days of average demand. */
  cover: {
    initialDays: number;
    reorderDays: number;
    orderUpToDays: number;
  };
  /** Emit feed streams while running (Phase 2). Off by default for speed. */
  emitFeeds: boolean;
  /**
   * Oracle mode: force the resolver to try only this action on every risk,
   * bypassing action selection (but still respecting feasibility + cost cap).
   * Used by the scorer to test, per action, whether service is recoverable.
   */
  forceAction?: import("@rally/domain").ResolutionAction;
  /**
   * Slice 11: the resolver DECIDES on state estimated from the live feeds, and
   * the chosen action's effect is replayed onto the true world. Requires feeds.
   */
  decideOnEstimatedState?: boolean;
}

/** Mutable inventory position keyed by facility|sku. */
export interface PositionCell {
  facilityId: string;
  skuId: string;
  onHandUnits: number;
  allocatedUnits: number;
  reorderPointUnits: number;
  orderUpToUnits: number;
  /** average units/hour of demand at this cell (for policy math). */
  hourlyDemand: number;
}

/** Per-cell accumulator for the current order bucket. */
export interface DemandBucket {
  startHour: number;
  demandUnits: number;
  servedUnits: number;
  unmetUnits: number;
}

/** Per-hour transaction log, consumed by the feed emitter to shed WMS events. */
export interface HourTxn {
  picks: Array<{ facilityId: string; skuId: string; qty: number }>;
  receipts: Array<{ facilityId: string; skuId: string; qty: number; shipmentRef?: string }>;
  shipConfirms: Array<{ facilityId: string; skuId: string; qty: number; shipmentRef: string }>;
  asns: Array<{ shipmentRef: string; originId: string; destId: string; skuId: string; qty: number; etaHour: number }>;
}

export interface RunMetrics {
  demandUnits: number;
  servedUnits: number;
  unmetUnits: number; // service missed
  stockoutHours: number; // (cell,hour) pairs with positive demand and zero stock
  actionCost: number; // cost of resolver actions committed
  ordersCreated: number;
  ordersDelivered: number;
  ordersBackordered: number;
  shipmentsCreated: number;
  shipmentsDelivered: number;
  shipmentsMissed: number; // customer shipments that never delivered full qty in time
}

export interface SimWorld {
  config: SimConfig;
  rng: Rng;
  hour: number;
  positions: Map<string, PositionCell>;
  shipments: Shipment[];
  orders: Order[];
  production: ProductionRun[];
  buckets: Map<string, DemandBucket>;
  exceptions: Exception[];
  risks: StockoutRisk[];
  decisions: ResolutionDecision[];
  metrics: RunMetrics;
  /** Transient transaction log for the current hour (reset each step). */
  txn: HourTxn;
  /** Per-cell last-fired shortfall, to edge-trigger risks AND re-fire when a
   *  cell's risk materially worsens (e.g. a spike lands after a marginal risk). */
  seenRiskKeys: Map<string, number>;
  /** id counters */
  seq: { shipment: number; order: number; run: number; exc: number; risk: number; asset: number };
  /** Opaque truck id assigned per shipment, so the estimator can't parse it. */
  assetOf: Map<string, string>;
  /** Active supplier short-ship (supply_shortfall) per dest cell → fraction cut. */
  pendingShort: Map<string, { fraction: number; untilHour: number }>;
  /** Ops holds already reported to the ops feed, so we emit only on change. */
  reportedFrozen: Set<string>;
  reportedQuality: Set<string>;
  /** Operational holds sensed for the resolver (set on the estimated path). */
  opsHolds?: import("@rally/domain").OpsHolds;
  /** Optional feed sink (Phase 2). */
  feedSink?: import("@rally/domain").AnyFeedMessage[];
  /** Per-source monotonic sequence counters for the feed emitter. */
  feedSeq: Map<string, number>;
}

export interface RunResult {
  config: SimConfig;
  finalState: ScenarioState;
  timeline: ScenarioState[]; // one snapshot per day
  exceptions: Exception[];
  risks: StockoutRisk[];
  decisions: ResolutionDecision[];
  metrics: RunMetrics;
  feeds?: import("@rally/domain").AnyFeedMessage[];
}
