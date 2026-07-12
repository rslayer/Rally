/**
 * Rally control tower — the whole system, running.
 *
 * Ingests from all live sources incrementally, re-estimates state each cycle,
 * detects projected stockouts on the ESTIMATE, and resolves or escalates each
 * new risk — decision-first, end to end, on sensor-grounded state.
 *
 *   npm run control-tower
 */

import type { Disruption } from "@rally/domain";
import { runControlTower } from "@rally/simulation";

const seed = Number(process.argv[2] ?? 4000);

// A lively multi-disruption week so the tower faces several risks to act on.
const disruptions: Disruption[] = [
  { disruptionId: "SPK1", type: "demand_spike", facilityId: "DC_OKC", skuId: "SKU_BAR", startHour: 60, durationHours: 48, magnitude: 2.0, label: "resolvable", expects: "projected_stockout" },
  { disruptionId: "SPK2", type: "demand_spike", facilityId: "DC_SAT", skuId: "SKU_COLA", startHour: 200, durationHours: 48, magnitude: 2.2, label: "resolvable", expects: "projected_stockout" },
  { disruptionId: "INJ", type: "demand_spike", facilityId: "DC_HOU", skuId: "SKU_CHIP", startHour: 300, durationHours: 40, magnitude: 8, label: "unresolvable", expects: "projected_stockout", injectedUnresolvable: true },
];

const bar = "─".repeat(76);
const result = await runControlTower(seed, disruptions);

console.log("\nRALLY · control tower running — ingest → estimate → detect → resolve");
console.log(bar);
console.log(`scenario   ${disruptions.length} disruptions over a 14-day week (seed ${seed})`);
console.log(bar);
console.log("clock  fresh  maxLag  estConf  openRisks  decisions");
for (const c of result.cycles) {
  if (c.freshFeeds === 0 && c.decisions === 0 && c.openRisks === 0) continue; // skip quiet cycles
  console.log(
    `${(c.hour + "h").padStart(5)}  ${String(c.freshFeeds).padStart(5)}  ${(c.maxLatencyMin + "m").padStart(6)}  ${c.estConfidence.toFixed(2).padStart(7)}  ${String(c.openRisks).padStart(9)}  ${String(c.decisions).padStart(9)}`,
  );
}

console.log(bar);
console.log(`decision log (${result.resolved} resolved · ${result.escalated} escalated)`);
for (const d of result.decisions.slice(0, 8)) {
  const tag = d.outcome === "resolved" ? "✔ resolve " : "⤴ escalate";
  console.log(`  ${(d.hour + "h").padStart(5)}  ${tag}  ${d.cell.padEnd(18)} ${d.action.padEnd(24)} "${d.rationale.slice(0, 42)}"`);
}

console.log(bar);
console.log(`stockout coverage        ${result.caughtStockoutCells}/${result.truthStockoutCells} ground-truth risk cells flagged by the live estimate`);
console.log("✅ the full loop runs on sensor-grounded state — the eyes drive the brain.\n");
