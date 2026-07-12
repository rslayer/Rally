/**
 * Canonical scenario state.
 *
 * This is what the state estimator produces and what the decision engine and UI
 * consume. Every entity carries a `confidence` so downstream code can reason
 * about state-estimate fidelity — the differentiator of the whole system.
 */

/** 0..1 confidence attached to an estimated entity. Direct-sim state is 1. */
export type Confidence = number;

export interface InventoryPositionState {
  facilityId: string;
  skuId: string;
  onHandUnits: number;
  allocatedUnits: number;
  availableUnits: number; // onHand - allocated (never negative)
  reorderPointUnits: number;
  confidence: Confidence;
}

export type ShipmentStatus =
  | "planned"
  | "in_transit"
  | "delivered"
  | "cancelled";

export type ShipmentKind = "customer" | "replenishment" | "transfer";

export interface Shipment {
  shipmentId: string;
  kind: ShipmentKind;
  laneId: string;
  originId: string;
  destId: string;
  skuId: string;
  quantityUnits: number;
  /** Identity linkage: the order this shipment fulfils (customer shipments). */
  orderId?: string;
  status: ShipmentStatus;
  departedAtHour?: number; // sim hour it left origin
  etaHour: number; // sim hour it is expected to arrive
  deliveredAtHour?: number;
  /** True once this shipment has been expedited by a resolver action. */
  expedited: boolean;
  confidence: Confidence;
}

export type OrderStatus =
  | "open"
  | "allocated"
  | "shipped"
  | "delivered"
  | "backordered";

export interface Order {
  orderId: string;
  customerId: string;
  skuId: string;
  quantityUnits: number;
  requestedByHour: number; // service is missed if not delivered by this hour
  /** Identity linkage: the shipment allocated to fulfil this order. */
  allocatedShipmentId?: string;
  status: OrderStatus;
  /** Units still owed when partially shipped / backordered. */
  backorderedUnits: number;
  confidence: Confidence;
}

export type ProductionStatus = "scheduled" | "running" | "complete" | "cancelled";

export interface ProductionRun {
  runId: string;
  facilityId: string; // a plant
  skuId: string;
  quantityUnits: number;
  scheduledStartHour: number;
  completesAtHour: number;
  status: ProductionStatus;
  confidence: Confidence;
}

/** A truck/trailer whose movement feed the estimator associates to a shipment. */
export interface AssetTrack {
  assetId: string;
  lastSeenHour: number;
  location: { lat: number; lon: number };
  atFacilityId?: string;
  associatedShipmentId?: string;
  confidence: Confidence;
}

/** Observable operational holds sensed from the ops-status feed. */
export interface OpsHolds {
  suspendedFacilities: string[]; // dock/throughput down (labor action)
  qualityHeldSkus: string[]; // network-wide quarantine
}

export interface ScenarioState {
  networkId: string;
  /** Sim hour this state describes. */
  hour: number;
  positions: InventoryPositionState[];
  shipments: Shipment[];
  orders: Order[];
  production: ProductionRun[];
  assets: AssetTrack[];
  /** Operational holds sensed from the ops feed (empty when none observed). */
  opsHolds: OpsHolds;
  /** Aggregate estimator confidence 0..1; 1 for direct-sim ground truth. */
  overallConfidence: Confidence;
}

export function positionKey(facilityId: string, skuId: string): string {
  return `${facilityId}::${skuId}`;
}

export function findPosition(
  state: ScenarioState,
  facilityId: string,
  skuId: string,
): InventoryPositionState | undefined {
  return state.positions.find(
    (p) => p.facilityId === facilityId && p.skuId === skuId,
  );
}
