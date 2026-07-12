/**
 * Rally proof artifact — run the escalation scoring harness across N seeds and
 * print the ThesisScorecard. This is where "most disruptions are resolvable
 * through automated decision-making" stops being a claim and becomes a measured
 * finding, with both failure modes surfaced, not hidden.
 *
 *   npm run harness            # default 25 seeds
 *   npm run harness -- 60      # 60 seeds
 */

import { buildScorecard } from "@rally/simulation";
import type { ScenarioRecord } from "@rally/simulation";

const nSeeds = Number(process.argv[2] ?? 25);
const seeds = Array.from({ length: nSeeds }, (_, i) => 4000 + i);

const t0 = Date.now();
const { scorecard, records, silentMiss, dangerous } = buildScorecard(seeds);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const bar = "═".repeat(66);

console.log(`\n${bar}`);
console.log("  RALLY · Escalation Scorecard — the thesis instrument");
console.log(`  ${seeds.length} seeds · ${records.length} live disruptions · ${secs}s`);
console.log(bar);

// ---- Per-type 2×2 ----
console.log("\n  Per disruption type — confusion cells");
console.log("  " + "─".repeat(64));
console.log(
  "  " +
    pad("type", 18) +
    pad("touchless", 11) +
    pad("TResolve", 10) +
    pad("TEscal", 8) +
    pad("FEscal", 8) +
    pad("FResolve", 9),
);
for (const [type, c] of Object.entries(scorecard.byExceptionType)) {
  console.log(
    "  " +
      pad(type, 18) +
      pad(pct(c.touchlessResolutionRate), 11) +
      pad(String(c.trueResolve), 10) +
      pad(String(c.trueEscalate), 8) +
      pad(String(c.falseEscalate), 8) +
      pad(flag(c.falseResolve), 9),
  );
}

// ---- Headline safety + value metrics ----
const inScope = records.filter((r) => r.category === "in_scope");
const inScopeTouchless = inScope.length ? inScope.filter((r) => r.cell === "trueResolve").length / inScope.length : 0;
const resolvable = records.filter((r) => r.resolvableTruth);
const ofResolvableTouchless = resolvable.length ? resolvable.filter((r) => r.cell === "trueResolve").length / resolvable.length : 0;

console.log("\n  Aggregate");
console.log("  " + "─".repeat(64));
row("aggregate touchless (all, incl. adversarial probes)", pct(scorecard.aggregateTouchlessRate));
row("touchless among in-scope disruptions", pct(inScopeTouchless));
row("touchless among truly-resolvable disruptions", pct(ofResolvableTouchless));
row("escalation safety recall (should-escalate caught)", pct(scorecard.escalationSafetyRecall), true);
row("escalation precision (escalations that were needed)", pct(scorecard.escalationPrecision));
row("confidence calibration (corr w/ correctness)", scorecard.calibration.toFixed(3));
row("value captured (service units saved)", scorecard.valueCaptured.toLocaleString());
row("value forgone to caution (recoverable, lost)", scorecard.valueForgone.toLocaleString());
row("DANGEROUS false resolves (claimed fix, still missed)", flag(dangerous));
if (silentMiss > 0) row("  of which undetected (silent) misses", String(silentMiss));

// ---- The safety-critical read: unresolvable must escalate ----
const unresolvable = records.filter((r) => !r.resolvableTruth);
const wronglyResolved = unresolvable.filter((r) => r.cell === "falseResolve" || r.cell === "silentMiss");
const injected = records.filter((r) => r.category === "injected_unresolvable");
const injectedDanger = injected.filter((r) => r.cell === "falseResolve" || r.cell === "silentMiss");
console.log("\n  Safety probe — injected-unresolvable + held-out must escalate");
console.log("  " + "─".repeat(64));
row("truly-unresolvable disruptions", String(unresolvable.length));
row("correctly escalated", String(unresolvable.filter((r) => r.cell === "trueEscalate").length));
row("dangerous false-resolves (rate)", `${flag(wronglyResolved.length)}  (${pct(wronglyResolved.length / Math.max(1, unresolvable.length))})`);
row("↳ injected-unresolvable falsely resolved", flag(injectedDanger.length), true);

// ---- Sample rationales ----
console.log("\n  Sample decisions");
console.log("  " + "─".repeat(64));
sample(records, "trueResolve", "✔ resolved");
sample(records, "trueEscalate", "⤴ escalated (correct)");
sample(records, "falseEscalate", "⤴ escalated (over-caution)");
sample(records, "falseResolve", "✘ FALSE RESOLVE");

// ---- Verdict ----
// Safety gate: injected-unresolvable disruptions must NEVER be falsely resolved,
// and the system must escalate ≥90% of everything that should escalate. The
// residual dangerous rate on the full unresolvable set is a measured finding,
// not a pass/fail — the instrument's job is to quantify it, not to hide it.
const dangerRate = wronglyResolved.length / Math.max(1, unresolvable.length);
const injectedDangerRate = injectedDanger.length / Math.max(1, injected.length);
const safe = injectedDangerRate <= 0.05 && scorecard.escalationSafetyRecall >= 0.9 && dangerRate <= 0.05;
console.log(`\n${bar}`);
console.log(
  `  VERDICT: touchless ${pct(scorecard.aggregateTouchlessRate)} · safety-recall ${pct(
    scorecard.escalationSafetyRecall,
  )} · dangerous ${pct(dangerRate)} (injected ${pct(injectedDangerRate)})`,
);
console.log(
  `  ${safe ? "✅ Resolves what it should; escalates what it must." : "❌ Unsafe: unresolvable cases slipped through."}`,
);
console.log(`${bar}\n`);

process.exit(safe ? 0 : 1);

/* --------------------------------- fmt ---------------------------------- */
function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function row(label: string, value: string, emphasize = false): void {
  const line = "  " + pad(label, 52) + value;
  console.log(emphasize ? `\x1b[1m${line}\x1b[0m` : line);
}
function flag(n: number): string {
  return n > 0 ? `\x1b[31m${n}\x1b[0m` : `${n}`;
}
function sample(records: ScenarioRecord[], cell: string, label: string): void {
  const r = records.find((x) => x.cell === cell);
  if (!r) return;
  console.log(`  ${pad(label, 26)} ${r.type} · ${r.action ?? "—"} · "${r.rationale.slice(0, 60)}"`);
}
