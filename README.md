# Rally 🚚

[![CI](https://github.com/rslayer/Rally/actions/workflows/ci.yml/badge.svg)](https://github.com/rslayer/Rally/actions/workflows/ci.yml)

**A supply-chain control tower that actually _decides_ — it resolves disruptions on its own, and raises its hand only when it should.**

Most "control towers" are really just dashboards. They light up a red alert, show you a map, and leave the actual fix to a human at 2 a.m. Rally flips that around: the thing it produces is a **resolved disruption**, not another chart to stare at. Visibility is an ingredient, never the meal.

And here's the part that matters — Rally doesn't just _claim_ it can do this. It **proves** it, with a scorecard you can reproduce from a seed.

---

## The one-minute version

There's a comforting story people tell about automation: _"most supply-chain disruptions are resolvable by software."_ Maybe! But the honest question isn't "what % did it fix?" — it's:

> **Does it fix what it should, and escalate what it can't?**

A system that auto-"resolves" 95% of problems but quietly fumbles the 5% that needed a human is _worse_ than one that safely handles 70%. So Rally scores itself with a confusion matrix, and treats one particular mistake — **claiming a fix that didn't actually work, with nobody warned** — as the cardinal sin.

The whole thing is deterministic and seeded, so every number in this README is a number you can regenerate.

---

## Try it in 30 seconds

```bash
git clone https://github.com/rslayer/Rally.git
cd Rally
npm install

npm run harness      # 👈 the proof: runs the escalation scorecard across many seeds
npm test             # 33 tests across all build phases
npm run web          # the three-panel control tower → http://localhost:8137

npm run backtest     # Slice 2: record a disruption, replay it through the real-feed adapter
npm run adapter      # ingest real-shaped vendor exports (CSV/JSON) → estimated state
npm run live-sync    # Slice 3: pull from a (mock) Samsara-shaped API — auth, paging, backfill
```

No build step, no Docker, no cloud. It runs on `tsx` and `vitest`. That's it.

---

## The scorecard (the whole point)

Every disruption lands in one of four boxes:

|                     | Was actually resolvable            | Was **not** resolvable                          |
| ------------------- | ---------------------------------- | ----------------------------------------------- |
| **Rally resolved**  | ✅ True Resolve — value captured    | 🚨 **False Resolve** — "fixed" it, still missed |
| **Rally escalated** | ⚠️ False Escalate — value forgone   | ✅ True Escalate — correct handoff               |

The two off-diagonal boxes are where the truth lives. **False Resolve is the dangerous one** — the system said "handled," service still failed, and no human ever got the memo. Rally is built to catch that failure mode and put it on the scoreboard, not sweep it under the rug.

Because the simulated world is _closed_, Rally can actually know the right answer. For every disruption it runs the scenario several times from the same seed:

- 🅰️ **hold** (do nothing) → how bad does it get on its own?
- 🅱️ **force each action** → could _any_ move have saved it? (this is the ground truth — decided independently of what Rally chose, so it never grades its own homework)
- 🅲 **live** → what Rally actually did.

### A representative run (30 seeds)

```
touchless among truly-resolvable disruptions      ~83%
escalation safety recall (caught what needs a human)  ~95%
injected-unresolvable correctly escalated         ~97–100%
dangerous false-resolve rate                      ~2–3%   (reported, not hidden)
confidence calibration (correlates w/ correctness)   ~0.26
```

"Where 95 lands" is the _finding_, not the assumption. The headline aggregate is deliberately pulled down because half the test cases are adversarial traps designed to be unfixable — that's how you find out whether the system knows its own limits.

---

## How it actually works

### 🔁 It closes the loop

A dashboard never closes the loop. Rally does:

1. **Demand eats inventory** every tick, scaled by forecast and any active disruption.
2. **A forward projection predicts a stockout** before it happens (and it's smart enough to account for the standing reorder policy _and_ finite plant capacity — so it doesn't cry wolf).
3. **A decision changes the future** — a transfer moves real units, a pull-forward advances a production run, an expedite compresses a lead time.
4. **The outcome gets measured** against the counterfactual.

Orders and shipments are tied together by **identity** (`orderId` ↔ its own shipment), so an order counts as delivered only when _its own_ shipment delivered it in full. The classic dashboard lie — _"22 missed shipments but 100% orders delivered"_ — is literally impossible here.

### 🧠 The resolver (deterministic on purpose)

A small, honest toolbox: `transfer_inventory` · `pull_forward_production` · `expedite_inbound` · `partial_ship_backorder` · `hold` · `escalate`.

It scores each feasible move by simulating its effect, then commits the cheapest one that fully protects service within policy — or it escalates. **Escalation is a feature, not a failure.** Rally raises its hand when nothing recovers service, when it isn't confident enough, when the shortfall is bigger than every ounce of spare inventory in the region, or when the problem is simply outside its wheelhouse (a shut-down dock, a quarantined product). No LLM magic — just a policy you can verify. A trustworthy 80% beats an unverifiable 95%.

### 👀 Sensor-grounded eyes (because the eyes decide the brain)

Every input looks like a real feed — GPS pings (Samsara/Motive/Geotab), warehouse transactions (EDI 940/945), lagging ERP inventory extracts — all behind one envelope. Synthetic and real sources travel the exact same path, so swapping in a real source later is a one-seam change (`packages/importers`).

A **state estimator** rebuilds the true picture from that messy stream, handling the three things a dashboard can't:

- **Association** — matching a GPS ping to the right shipment even when the reference is missing.
- **Gaps & lateness** — stale snapshots and dropped messages lower _confidence_ instead of getting dropped.
- **Interpolation** — rolling inventory forward between lagging snapshots and reconciling the drift.

Rebuilt purely from feeds, the estimate lands within **~1%** of ground truth between snapshots. Better eyes → better prediction → better decision — and when the eyes are unsure, that uncertainty flows through and nudges Rally toward escalating.

---

## A tour of the repo

```
packages/
  domain/       the shared vocabulary — feeds, state, risks, decisions, the scorecard
  data-gen/     the Texas–Oklahoma network, demand, seeded RNG, disruption generator
  simulation/   the brains: state-estimator · inventory-kernel (the loop) ·
                projection · resolver · scorer (oracle + 2×2) · backtest (record→replay)
  importers/    the real-feed seam — validation, gap/lateness detection, the vendor
                codec (export files ⇄ FeedEnvelope), and the live Samsara-shaped
                connector (auth · pagination · backfill · retry · checkpoint) + its mock
apps/
  worker/       runs the sweep and prints the scorecard   (npm run harness)
  web/          the three-panel control tower              (npm run web)
  adapter/      file ingest, live sync, fixtures, mock API (npm run adapter / live-sync / …)
fixtures/
  real-feed/    vendor-shaped exports a customer would hand you (telematics.csv,
                wms.csv, inventory.json) + the observed outcome (observed.json)
```

Everything downstream reads one `ScenarioState` shape, so the estimator, the decision engine, and the UI all consume estimated state without knowing or caring where it came from.

---

## Built in phases, each with a gate it had to pass

| Phase | What                     | The bar it had to clear                                              |
| :---: | ------------------------ | ------------------------------------------------------------------- |
|   0   | Domain types             | typechecks clean                                                    |
|   1   | Close the loop           | real stockouts appear; orders and shipments stay consistent         |
|   2   | State estimator          | rebuilt-from-feeds state matches truth within tolerance             |
|   3   | Resolver                 | beats the do-nothing baseline on stockout-hours                     |
|   4   | Scoring harness          | prints both failure modes; unfixable traps get escalated, not faked |
|   5   | Real-feed adapter + backtest | replayed observed disruption is reproduced within tolerance     |

Each gate has a runnable script — they're the receipts.

```bash
npx tsx packages/simulation/src/dev/loop-check.ts        # Phase 1
npx tsx packages/simulation/src/dev/estimator-check.ts   # Phase 2
npx tsx packages/simulation/src/dev/resolver-check.ts    # Phase 3
npm run harness -- 40                                    # Phase 4
npm run backtest                                         # Phase 5
```

---

## Honest caveats (because that's the whole spirit)

- The ~2–3% dangerous false-resolves are **real and shown on the scorecard**. The stragglers are sustained mega-spikes that one-shot actions only _partly_ fix — the proper cure is raising a standing policy level, a lever deliberately left out of this slice's toolbox. Surfacing that is exactly what the instrument is for.
- It's a **closed simulated world** on purpose — that's the only way to have a perfect oracle to grade against. The file adapter + backtest (Slice 2) and the production-shaped live connector (Slice 3) are the bridge out; the connector is developed and CI-tested against a faithful **mock** of the vendor API, so the only step left to run against production is a real base URL + token.
- The resolver is **deterministic by design**. Model-based judgment is welcome later — but only where a plain policy provably can't decide, and only if it beats this baseline.

---

## Slice 2 — the real-feed bridge 🌉

Slice 1 proved the thesis in a closed world. Slice 2 is the bridge to a real one — and it's the same seam, not a rewrite.

**A real adapter.** A customer doesn't hand you `FeedEnvelope` objects; they hand you exports — a Samsara GPS dump, a WMS transaction log, an ERP on-hand extract. The vendor codec in `packages/importers` parses those files (`telematics.csv`, `wms.csv`, `inventory.json`) into the exact same envelope stream the synthetic generator produces. The platform's own sequence ids and timestamps ride along, so **gaps and lateness survive** and the estimator still down-weights shaky state. `npm run adapter` runs it end to end from files on disk and prints the reconstructed state plus the data-quality issues a real pipeline would flag.

**A backtest.** `npm run backtest` records an observed episode (the imperfect feeds a real fleet sheds, plus the ground-truth physical outcome), then _replays those feeds back through the adapter and estimator_ and checks the simulator reproduces what actually happened:

```
state reproduction      mean 0.02%   max 0.25%      (rebuilt from vendor-round-tripped feeds)
disrupted cell bottom   observed 0u @108h · reproduced 0u @108h · timing error 0h
deterministic replay    true
```

That's the whole point of building the seam this way: pointing Rally at a real telematics or WMS export is a **data-source swap**, and the backtest is how you'd earn trust that the twin matches reality before letting it decide anything.

## Slice 3 — the live vendor-API connector 🔌

A file export is one way in; a real fleet API is the other. `packages/importers/live` is a **production-shaped Samsara connector** — the real analog for PepsiCo-owned telematics — with everything a live integration actually needs:

- **Auth** — bearer token read from the environment, never hardcoded; auth failures are *not* retried.
- **Pagination** — cursor-based, following `endCursor` until the window is drained.
- **Backfill** — a time-windowed historical pull that maps every GPS row into the same `FeedEnvelope<MovementEvent>`.
- **Resilience** — retry with backoff on 429 / 5xx, honoring `Retry-After`.
- **Resumability** — a `Checkpoint` after every page, so a crashed or rate-limited sync picks up exactly where it left off — no gaps, no double-pulls.

Because I have no real Samsara account (and won't handle anyone's credentials), the connector is developed and CI-tested against a **faithful mock** of the API — the same way you'd build a real integration behind a sandbox. `npm run live-sync` runs the whole thing: it authenticates, backfills the window (surviving an injected rate-limit), merges the **live** telematics stream with **batch** WMS/ERP feeds, and hands the lot to the estimator:

```
backfill                17 pages · 1631 GPS rows
resilience              1 retry · 1 rate-limit hit handled
checkpoint (resumable)  rows=1631
estimated @ 108h        confidence 1 · drift ≤ 4u · 24 assets tracked (21 in transit)
```

Going live is two environment variables — nothing else moves:

```bash
RALLY_SAMSARA_BASE_URL=https://api.samsara.com \
RALLY_SAMSARA_TOKEN=***your-token*** \
npm run live-sync
```

---

<sub>The proof is the scorecard. Both failure modes are surfaced, not hidden. That's a defensible test of "most disruptions are resolvable through automated decision-making" — and an honest answer either way.</sub>
