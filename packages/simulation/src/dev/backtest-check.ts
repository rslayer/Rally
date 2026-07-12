/**
 * Phase 5 acceptance gate — backtest.
 *
 * Record an observed episode, then replay its feeds back through the real-feed
 * adapter (vendor files → envelopes) and the state estimator, and confirm the
 * simulator reproduces the observed physical outcome:
 *   • state rebuilt from the round-tripped feeds matches ground truth,
 *   • the disrupted cell bottoms out at the same depth and ~time, and
 *   • the model replays deterministically.
 */

import { recordEpisode, backtest } from "../backtest.js";
import { EPISODE_DISRUPTION, EPISODE_SEED } from "@rally/data-gen";

const episode = recordEpisode(EPISODE_SEED, EPISODE_DISRUPTION);
const r = backtest(episode, true);

console.log("── Phase 5 · backtest (record → replay) ──────────────────");
console.log(`episode                  ${episode.disruption.type} @ ${episode.disruption.facilityId}/${episode.disruption.skuId} (seed ${episode.seed})`);
console.log(`feed messages replayed   ${r.feedMessages} (via vendor CSV/JSON round-trip: ${r.vendorRoundTrip})`);
console.log(`observed exceptions      ${r.observedExceptions} · stockout-hours ${episode.stockoutHours}`);
console.log(`state reproduction       mean ${(r.stateMeanRelErr * 100).toFixed(2)}%  max ${(r.stateMaxRelErr * 100).toFixed(2)}%  (worst ${r.worstCell})`);
console.log(`disrupted cell bottom     observed ${r.disrupted.observedMin}u @${r.disrupted.observedMinHour}h · reproduced ${r.disrupted.reproducedMin}u @${r.disrupted.reproducedMinHour}h`);
console.log(`stockout timing error    ${r.disrupted.timingErrorHours}h`);
console.log(`deterministic replay     ${r.deterministic}`);
console.log("──────────────────────────────────────────────────────────");
console.log(r.pass ? "GATE PASS ✅" : "GATE FAIL ❌");
process.exit(r.pass ? 0 : 1);
