# Rally

**A decision-first supply-chain control tower that resolves disruptions autonomously and escalates only what it should.**

Most "control towers" are visibility products: they show you a problem and leave you to fix it. Rally inverts that. The primary output is a **resolved disruption**, not a dashboard. Visibility is an input to the decision, never the product.

Slice 1 is one honest vertical slice that tests a single thesis:

> *Most disruptions are resolvable through automated decision-making — and the ones that aren't get escalated, not silently mishandled.*

The proof is not a claim. It is a **scorecard**.

```
npm install
npm run harness      # runs the escalation scorecard across N seeds → the proof artifact
npm test             # 18 tests across all four phases
npm run web          # http://localhost:8137 — the three-panel control tower
```

---

## The thesis instrument

The wrong question is "what percentage did the system resolve." The right question is "does it resolve what it *should* and escalate what it *must*." That is a confusion matrix, not a single number.

|                     | Was resolvable                     | Was **not** resolvable                          |
| ------------------- | ---------------------------------- | ----------------------------------------------- |
| **Agent resolved**  | True Resolve — value captured      | **False Resolve** — claimed a fix, still missed |
| **Agent escalated** | **False Escalate** — value forgone | True Escalate — correct handoff                 |

The two off-diagonal cells are the real findings. **False Resolve is the failure that discredits the thesis** — the system said it was handled, the service still missed, and no human was warned. It is weighted accordingly, and the harness is built to surface it, not hide it.

The world is closed, so the harness can know the truth. For every disruption it runs the scenario multiple times from the same seed:

- a **hold** counterfactual (resolver off) — establishes the real service miss;
- one **forced-action** counterfactual per constructive action — establishes, *independently of what the resolver chose*, whether any in-set action actually recovers service within policy → the ground-truth `resolvable` label;
- the **live** resolver run — the decision under test.

The label comes from executed counterfactuals, not from the resolver's own projection, so the system never grades its own homework.

### A representative run (25 seeds)

```
aggregate touchless (all, incl. adversarial probes)   ~22%
touchless among truly-resolvable disruptions          ~70%
escalation safety recall (should-escalate caught)     ~97%
escalation precision (escalations that were needed)   ~95%
confidence calibration (corr w/ correctness)          ~0.26
injected-unresolvable correctly escalated             ~97-100%
dangerous false-resolve rate                          ~2-3%   (surfaced, not hidden)
```

"Where 95 lands" is the finding, not the assumption. The aggregate is dragged down on purpose — half the scenario mix is adversarial (deliberately-unresolvable and out-of-scope probes). The honest reads are all three numbers together.

---

## How the loop closes

A visibility dashboard never closes the loop. Rally does:

1. **Demand draws inventory down** every tick, scaled by forecast and active disruption multipliers.
2. **Low projected inventory predicts a stockout** via a policy-aware forward projection.
3. **A decision mutates future state** — a transfer moves units, a pull-forward advances a run, an expedite compresses a lead time.
4. **The outcome is measured** by the oracle against the counterfactual.

Orders and shipments are linked by **identity** (`orderId` ↔ `allocatedShipmentId`), so an order is delivered *iff its own shipment delivered it in full*. The classic "22 missed shipments but 100% orders delivered" contradiction is structurally impossible.

### The resolver (deterministic first)

A finite action set, each with a defined effect on future state:

`transfer_inventory` · `pull_forward_production` · `expedite_inbound` · `partial_ship_backorder` · `hold` · `escalate`

The resolver scores each feasible action by counterfactual projection and commits the cheapest one that fully protects service within policy — or escalates. Escalation is a **first-class outcome**. It escalates when no action recovers service, when confidence is below threshold, when the shortfall exceeds all redirectable regional surplus, or when the risk is out of designed scope (a suspended dock, a quarantined SKU). The autonomy claim is earned against a deterministic baseline before any model-based judgment is added.

---

## Sensor-grounded state (the eyes determine the brain)

Every input arrives as an event or snapshot shaped like a real feed — telematics (Samsara/Motive/Geotab), WMS transactions (EDI 940/945), and lagging ERP inventory extracts — all behind one `FeedEnvelope`. Synthetic and real sources share the identical path, so synthetic → real is a data-source swap at a single seam (`packages/importers`).

The **state estimator** rebuilds canonical state from the merged stream and owns the three problems that separate this from a dashboard:

- **Association** — binds movement pings to shipments when `shipmentRef` is missing, via same-truck propagation and geofence/lane geography.
- **Gap & lateness** — sequence gaps and stale snapshots are first-class; affected state gets *reduced confidence*, not dropped.
- **Interpolation** — rolls on-hand forward from the warehouse stream between lagging snapshots and reconciles drift against the next anchor.

State rebuilt purely from feeds matches direct-sim ground truth to **~1% mean error** at hours between snapshots. A better estimate of physical state is a better stockout prediction is a better decision — so the estimated confidence flows into the risk, and low confidence biases toward escalation.

---

## Phased build & acceptance gates

Each phase has a hard gate; the dev scripts are the runnable proofs.

| Phase | What                                    | Gate (script)                                                             |
| ----- | --------------------------------------- | ------------------------------------------------------------------------- |
| 0     | Domain types                            | `npm run typecheck` clean                                                 |
| 1     | Close the loop                          | `tsx packages/simulation/src/dev/loop-check.ts` — nonzero exceptions, order↔shipment consistent |
| 2     | State layer + estimator                 | `tsx packages/simulation/src/dev/estimator-check.ts` — feeds ≈ truth within tolerance |
| 3     | Resolver                                | `tsx packages/simulation/src/dev/resolver-check.ts` — resolver reduces stockout-hours vs hold |
| 4     | Scoring harness                         | `npm run harness` — scorecard prints both failure modes; injected-unresolvable escalated, not falsely resolved |

```
npx tsx packages/simulation/src/dev/loop-check.ts        # Phase 1
npx tsx packages/simulation/src/dev/estimator-check.ts   # Phase 2
npx tsx packages/simulation/src/dev/resolver-check.ts    # Phase 3
npm run harness -- 40                                    # Phase 4 (40 seeds)
```

---

## Repo layout

```
packages/
  domain/         feed envelopes + events, ScenarioState, StockoutRisk,
                  ResolutionDecision, ThesisScorecard, Disruption
  data-gen/       Texas–Oklahoma network fixture, demand model, seeded RNG,
                  stochastic labeled disruption generator
  simulation/     state-estimator · inventory-kernel (the closed loop) ·
                  projection · resolver · scorer (oracle, 2×2, calibration) ·
                  step (orchestration) · run
  importers/      the real-feed seam — validate/normalize FeedEnvelope streams,
                  example telematics/WMS/ERP adapters
apps/
  worker/         runs the multi-seed sweep and prints the ThesisScorecard
  web/            the three-panel control tower (state · decisions · scorecard)
```

Everything downstream reads `ScenarioState`, so the estimator, decision engine, and UI consume estimated state through the same shape with no changes.

---

## Calibration — guarding against grading your own homework

- **Stochastic generation.** Disruptions are drawn from seeded distributions over type, timing, severity, and location — never hand-placed. Reproducible by seed, swept across many seeds.
- **Held-out types.** `labor_action` and `quality_hold` are outside the resolver's designed scope. The correct behavior is to escalate; the scorecard measures whether it does.
- **Injected-unresolvable.** Shortfalls larger than all regional surplus combined. The correct behavior is to escalate. This directly measures False Resolve — the deterministic resolver escalates ~97–100% of them, and the scorecard reports the residual rather than pretending it is zero. (The stragglers are sustained mega-spikes that one-shot actions only *partially* recover; the honest fix is a policy lever outside Slice 1's action set — exactly the kind of finding the instrument exists to surface.)

---

## Non-goals for Slice 1

Real integrations (the adapter seam is here; a live source is Phase 5). LLM agents — the resolver is deterministic; a verifiable 80% beats an unverifiable 95% as *proof*. Multi-region, auth, UI polish, and a carrier-communication agent (no counterparty in a closed world). Add model-based judgment only where a deterministic policy demonstrably cannot decide, and measure the lift against this baseline.

---

*The proof is the scorecard. The two failure modes are surfaced, not hidden. That is a defensible test of "most disruptions are resolvable through automated decision-making."*
