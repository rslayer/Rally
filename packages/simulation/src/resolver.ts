/**
 * Deterministic resolver. Given a StockoutRisk, it enumerates the finite action
 * set, scores each by counterfactual projection, and either commits the cheapest
 * action that fully protects service within policy — mutating future state — or
 * escalates. Escalation is a first-class outcome, not a failure.
 */

import type {
  ResolutionAction,
  ResolutionDecision,
  ResolutionEffect,
  StockoutRisk,
} from "@rally/domain";
import { PLANT_ID, DC_IDS } from "@rally/data-gen";
import { lane } from "@rally/domain";
import { projectCell } from "./projection.js";
import { available, getCell } from "./kernel-util.js";
import { createReplenishment, RISK_HORIZON_HOURS } from "./inventory-kernel.js";
import { laneLeadHours } from "./lead.js";
import { outOfScopeHold } from "./apply.js";
import type { SimWorld } from "./types.js";

const PULL_FORWARD_LEAD_HOURS = 2;
const PULL_FORWARD_PENALTY_PER_UNIT = 1.5;
const BACKORDER_PENALTY_PER_UNIT = 4;

interface Candidate {
  action: ResolutionAction;
  recovery: number; // 0..1 fraction of shortfall the action removes
  cost: number;
  rationale: string;
  apply: () => ResolutionEffect | undefined;
}

/** Total surplus that could physically be redirected to cover a shortfall of
 *  this SKU: every DC's above-reorder-point stock, plus the plant's on-hand. */
function regionalSupply(world: SimWorld, skuId: string): number {
  let sum = 0;
  for (const cell of world.positions.values()) {
    if (cell.skuId !== skuId) continue;
    if (cell.facilityId === PLANT_ID) sum += available(cell);
    else sum += Math.max(0, available(cell) - cell.reorderPointUnits);
  }
  return sum;
}

function buffer(world: SimWorld, facilityId: string, skuId: string): number {
  // Half a day of cover on top of the peak shortfall — enough to carry a cell
  // through the shock without over-draining the donor DC.
  const cell = getCell(world, facilityId, skuId);
  return cell ? Math.max(1, Math.round(cell.hourlyDemand * 12)) : 0;
}

function recoveryFraction(originalShortfall: number, residual: { crosses: boolean; shortfallUnits: number }): number {
  if (!residual.crosses) return 1;
  if (originalShortfall <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - residual.shortfallUnits / originalShortfall));
}

/* --------------------------- candidate builders --------------------------- */

function transferCandidates(world: SimWorld, risk: StockoutRisk): Candidate[] {
  const { facilityId: dc, skuId } = risk;
  const from = world.hour;
  const need = risk.projectedShortfallUnits + buffer(world, dc, skuId);
  const out: Candidate[] = [];
  for (const src of DC_IDS) {
    if (src === dc) continue;
    const ln = lane(world.config.network, src, dc);
    if (!ln) continue;
    const srcCell = getCell(world, src, skuId);
    if (!srcCell) continue;
    const surplus = available(srcCell) - srcCell.reorderPointUnits;
    if (surplus <= 0) continue;
    const qty = Math.round(Math.min(need, surplus));
    if (qty <= 0) continue;
    const arrival = from + laneLeadHours(ln.transitHours, false);
    // Source must stay healthy after donating.
    const srcProj = projectCell(world, src, skuId, from, RISK_HORIZON_HOURS, { onHandDelta: -qty });
    if (srcProj.crosses) continue;
    const destProj = projectCell(world, dc, skuId, from, RISK_HORIZON_HOURS, {
      inboundDeltas: [{ hour: arrival, qty }],
    });
    const recovery = recoveryFraction(risk.projectedShortfallUnits, destProj);
    const cost = Math.round(qty * ln.costPerUnit);
    out.push({
      action: "transfer_inventory",
      recovery,
      cost,
      rationale: `transfer ${qty}u ${skuId} ${src}→${dc}, ETA +${laneLeadHours(ln.transitHours, false)}h (surplus at ${src})`,
      apply: () => {
        const ship = createReplenishment(world, src, dc, skuId, qty, false);
        return ship
          ? { kind: "transfer_inventory", fromFacilityId: src, toFacilityId: dc, skuId, units: ship.quantityUnits, shipmentId: ship.shipmentId }
          : undefined;
      },
    });
  }
  return out;
}

function expediteCandidates(world: SimWorld, risk: StockoutRisk): Candidate[] {
  const { facilityId: dc, skuId } = risk;
  const from = world.hour;
  const out: Candidate[] = [];
  for (const s of world.shipments) {
    if (s.destId !== dc || s.skuId !== skuId || s.kind === "customer") continue;
    if (s.status !== "in_transit" && s.status !== "planned") continue;
    if (s.expedited) continue;
    const ln = lane(world.config.network, s.originId, s.destId);
    if (!ln?.expeditedTransitHours || !ln.expeditedCostPerUnit) continue;
    const dep = s.departedAtHour ?? from;
    const newEta = Math.max(from + 1, dep + laneLeadHours(ln.expeditedTransitHours, true));
    if (newEta >= s.etaHour) continue;
    const destProj = projectCell(world, dc, skuId, from, RISK_HORIZON_HOURS, {
      inboundDeltas: [
        { hour: s.etaHour, qty: -s.quantityUnits },
        { hour: newEta, qty: s.quantityUnits },
      ],
    });
    const recovery = recoveryFraction(risk.projectedShortfallUnits, destProj);
    const cost = Math.round(s.quantityUnits * (ln.expeditedCostPerUnit - ln.costPerUnit));
    out.push({
      action: "expedite_inbound",
      recovery,
      cost,
      rationale: `expedite inbound ${s.shipmentId} (${s.quantityUnits}u), ETA ${s.etaHour}h→${newEta}h`,
      apply: () => {
        const oldEta = s.etaHour;
        s.etaHour = newEta;
        s.expedited = true;
        return { kind: "expedite_inbound", shipmentId: s.shipmentId, oldEtaHour: oldEta, newEtaHour: s.etaHour };
      },
    });
  }
  return out;
}

function pullForwardCandidates(world: SimWorld, risk: StockoutRisk): Candidate[] {
  const { facilityId: dc, skuId } = risk;
  const from = world.hour;
  const ln = lane(world.config.network, PLANT_ID, dc);
  if (!ln) return [];
  const run = world.production.find(
    (r) => r.skuId === skuId && (r.status === "scheduled" || r.status === "running") && r.completesAtHour > from + PULL_FORWARD_LEAD_HOURS,
  );
  if (!run) return [];
  const plantCell = getCell(world, PLANT_ID, skuId);
  if (!plantCell) return [];
  const need = risk.projectedShortfallUnits + buffer(world, dc, skuId);
  const qty = Math.round(Math.min(need, available(plantCell) + run.quantityUnits));
  if (qty <= 0) return [];
  const transit = ln.expeditedTransitHours ?? ln.transitHours;
  const arrival = from + PULL_FORWARD_LEAD_HOURS + laneLeadHours(transit, true);
  const destProj = projectCell(world, dc, skuId, from, RISK_HORIZON_HOURS, {
    inboundDeltas: [{ hour: arrival, qty }],
  });
  const recovery = recoveryFraction(risk.projectedShortfallUnits, destProj);
  const laneCost = qty * (ln.expeditedCostPerUnit ?? ln.costPerUnit);
  const cost = Math.round(qty * PULL_FORWARD_PENALTY_PER_UNIT + laneCost);
  return [
    {
      action: "pull_forward_production",
      recovery,
      cost,
      rationale: `pull forward ${run.runId} (+expedite ${qty}u ${PLANT_ID}→${dc}), ETA +${PULL_FORWARD_LEAD_HOURS + Math.ceil(transit)}h`,
      apply: () => {
        const fromH = run.completesAtHour;
        run.completesAtHour = from + PULL_FORWARD_LEAD_HOURS;
        run.scheduledStartHour = Math.min(run.scheduledStartHour, from);
        // Realize the pulled-forward units at the plant so the ship can leave.
        plantCell.onHandUnits += run.quantityUnits;
        run.status = "complete";
        createReplenishment(world, PLANT_ID, dc, skuId, qty, true);
        return { kind: "pull_forward_production", runId: run.runId, fromHour: fromH, toHour: run.completesAtHour };
      },
    },
  ];
}

function partialShipCandidate(world: SimWorld, risk: StockoutRisk): Candidate {
  const { facilityId: dc, skuId } = risk;
  const customer = world.config.network.customers.find((c) => c.servedByFacilityId === dc);
  const priority = customer?.priority ?? 0.5;
  const shortfall = risk.projectedShortfallUnits;
  const protectedUnits = Math.round(shortfall * priority);
  return {
    action: "partial_ship_backorder",
    recovery: priority, // protects only the priority fraction — never a full resolve
    cost: Math.round((shortfall - protectedUnits) * BACKORDER_PENALTY_PER_UNIT),
    rationale: `protect priority ${(priority * 100).toFixed(0)}% (${protectedUnits}u), backorder ${shortfall - protectedUnits}u`,
    apply: () => ({ kind: "partial_ship_backorder", orderId: `future-${dc}-${skuId}`, shippedUnits: protectedUnits, backorderedUnits: shortfall - protectedUnits }),
  };
}

/* ------------------------------- decide ---------------------------------- */

function candidatesFor(world: SimWorld, risk: StockoutRisk): Candidate[] {
  const force = world.config.forceAction;
  if (force) {
    // Oracle mode: only build the forced action's candidates.
    switch (force) {
      case "transfer_inventory":
        return transferCandidates(world, risk);
      case "expedite_inbound":
        return expediteCandidates(world, risk);
      case "pull_forward_production":
        return pullForwardCandidates(world, risk);
      case "partial_ship_backorder":
        return [partialShipCandidate(world, risk)];
      default:
        return [];
    }
  }
  return [
    ...transferCandidates(world, risk),
    ...expediteCandidates(world, risk),
    ...pullForwardCandidates(world, risk),
    partialShipCandidate(world, risk),
  ];
}

export function resolveRisk(world: SimWorld, risk: StockoutRisk): ResolutionDecision {
  const policy = world.config.policy;

  // Oracle force mode bypasses the confidence gate: it tests physical + policy
  // feasibility of the action, not the resolver's own risk appetite.
  const forced = !!world.config.forceAction;

  // Out-of-scope operational holds are escalated before any action is considered:
  // no in-set action can land against a suspended dock or a quarantined SKU.
  if (!forced) {
    const scope = outOfScopeHold(world.config.disruptions, risk.facilityId, risk.skuId, world.hour, RISK_HORIZON_HOURS);
    if (scope.held) return escalate(risk, scope.reason, 0, []);

    // Safety guard: if the peak shortfall exceeds all redirectable regional
    // surplus, no in-set action can truly recover it — escalate, do not gamble.
    const supply = regionalSupply(world, risk.skuId);
    if (risk.projectedShortfallUnits > supply * 0.9) {
      return escalate(risk, `shortfall ${risk.projectedShortfallUnits}u exceeds regional surplus ${Math.round(supply)}u`, 0, []);
    }
  }

  const candidates: Candidate[] = candidatesFor(world, risk);

  // Best achievable recovery, for value accounting when we escalate.
  const bestRecovery = candidates.reduce((m, c) => Math.max(m, c.recovery), 0);

  // Low confidence → escalate before acting (skipped in oracle force mode).
  if (!forced && risk.confidence < policy.minConfidence) {
    return escalate(risk, "risk confidence below autonomous threshold", bestRecovery, candidates);
  }

  const fullyRecovering = candidates
    .filter((c) => c.recovery >= policy.minServiceRecovery)
    .sort((a, b) => a.cost - b.cost);

  if (fullyRecovering.length === 0) {
    return escalate(risk, "no in-set action recovers service within horizon", bestRecovery, candidates);
  }

  const affordable = fullyRecovering.filter((c) => c.cost <= policy.maxAutonomousCost);
  if (affordable.length === 0) {
    const cheapest = fullyRecovering[0]!;
    return escalate(
      risk,
      `recovery requires ${cheapest.action} at $${cheapest.cost} > cost cap $${policy.maxAutonomousCost}`,
      bestRecovery,
      candidates,
    );
  }

  const chosen = affordable[0]!;
  const effect = chosen.apply();
  world.metrics.actionCost += chosen.cost;
  return {
    riskId: risk.riskId,
    action: chosen.action,
    rationale: chosen.rationale,
    projectedServiceRecovery: chosen.recovery,
    projectedCost: chosen.cost,
    confidence: risk.confidence,
    policyResult: { allowed: true, reason: "within cost cap and confidence threshold" },
    outcome: "resolved",
    ...(effect ? { effect } : {}),
  };
}

function escalate(
  risk: StockoutRisk,
  reason: string,
  bestRecovery: number,
  candidates: Candidate[],
): ResolutionDecision {
  const cheapestFull = candidates
    .filter((c) => c.recovery >= 0.999)
    .sort((a, b) => a.cost - b.cost)[0];
  return {
    riskId: risk.riskId,
    action: "escalate",
    rationale: reason,
    projectedServiceRecovery: bestRecovery,
    projectedCost: cheapestFull?.cost ?? 0,
    confidence: risk.confidence,
    policyResult: { allowed: false, reason },
    outcome: "escalated",
  };
}

export function resolveRisks(world: SimWorld, fresh: StockoutRisk[]): void {
  for (const risk of fresh) {
    const decision = resolveRisk(world, risk);
    world.decisions.push(decision);
  }
}
