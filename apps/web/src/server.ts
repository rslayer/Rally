/**
 * Rally control-tower dashboard — three panels, one region.
 *
 *   • State layer      — track-and-trace as a READ of estimated state (Phase 2).
 *   • Decision queue   — resolutions and escalations with rationale (Phase 3).
 *   • Escalation scorecard — the thesis instrument (Phase 4).
 *
 * Decision-first: the resolved/escalated queue is the product; the state layer is
 * an input to it, never the point. Run:  npm run web   → http://localhost:8137
 */

import { createServer } from "node:http";
import { buildShowcase, type Showcase } from "./showcase.js";

const PORT = Number(process.env.PORT ?? 8137);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function confBar(c: number): string {
  const w = Math.round(c * 100);
  const hue = Math.round(c * 120); // red→green
  return `<span class="cbar"><span style="width:${w}%;background:hsl(${hue} 70% 45%)"></span></span><span class="cnum">${c.toFixed(2)}</span>`;
}

async function render(seed: number): Promise<string> {
  const s = await buildShowcase(seed);
  const sc = s.scorecard;

  // ---- Panel 1: state layer ----
  const byFac = new Map<string, typeof s.estimated.positions>();
  for (const p of s.estimated.positions) {
    if (!p.facilityId.startsWith("DC_")) continue;
    (byFac.get(p.facilityId) ?? byFac.set(p.facilityId, []).get(p.facilityId)!).push(p);
  }
  let stateRows = "";
  for (const [fac, positions] of byFac) {
    stateRows += `<tr class="facrow"><td colspan="5">${esc(fac)}</td></tr>`;
    for (const p of positions) {
      const atRisk = p.availableUnits < p.reorderPointUnits;
      stateRows += `<tr>
        <td class="sku">${esc(p.skuId)}</td>
        <td class="num">${p.onHandUnits.toLocaleString()}</td>
        <td class="num">${p.availableUnits.toLocaleString()}</td>
        <td>${atRisk ? '<span class="badge risk">at&nbsp;risk</span>' : '<span class="badge ok">ok</span>'}</td>
        <td>${confBar(p.confidence)}</td>
      </tr>`;
    }
  }
  const assetRows = s.estimated.assets
    .slice(0, 10)
    .map((a) => `<tr><td>${esc(a.assetId)}</td><td>${esc(a.associatedShipmentId ?? "—")}</td><td>${esc(a.atFacilityId ?? "in transit")}</td><td>${confBar(a.confidence)}</td></tr>`)
    .join("");

  // ---- Panel 2: decision queue (a sample of real graded decisions) ----
  const decRows = s.decisions
    .map((d) => {
      const cls = d.outcome === "resolved" ? "resolved" : "escalated";
      const mark = d.correct ? '<span class="mark good">✓</span>' : '<span class="mark bad">✗</span>';
      const impact = d.outcome === "resolved"
        ? (d.serviceSaved ? `+${d.serviceSaved.toLocaleString()}u saved` : "—")
        : `${d.holdUnmet.toLocaleString()}u at stake`;
      return `<tr class="${cls}">
        <td>${esc(d.type)}</td>
        <td><span class="badge ${cls}">${d.outcome}</span> ${mark}</td>
        <td>${esc(d.action)}</td>
        <td class="rationale">${esc(d.rationale)}</td>
        <td class="num">${impact}</td>
        <td>${confBar(d.confidence)}</td>
      </tr>`;
    })
    .join("");
  const nResolved = s.decisions.filter((d) => d.outcome === "resolved").length;
  const nEscalated = s.decisions.filter((d) => d.outcome !== "resolved").length;

  // ---- Panel 3: scorecard ----
  const typeRows = Object.entries(sc.byExceptionType)
    .map(([t, c]) => `<tr>
      <td>${esc(t)}</td>
      <td class="num">${pct(c.touchlessResolutionRate)}</td>
      <td class="num good">${c.trueResolve}</td>
      <td class="num good">${c.trueEscalate}</td>
      <td class="num warn">${c.falseEscalate}</td>
      <td class="num ${c.falseResolve ? "bad" : ""}">${c.falseResolve}</td>
    </tr>`)
    .join("");

  const injected = s.records.filter((r) => r.category === "injected_unresolvable");
  const injectedDanger = injected.filter((r) => r.cell === "falseResolve" || r.cell === "silentMiss").length;
  const unresolvable = s.records.filter((r) => !r.resolvableTruth);
  const dangerRate = unresolvable.length ? unresolvable.filter((r) => r.cell === "falseResolve" || r.cell === "silentMiss").length / unresolvable.length : 0;
  const safe = injectedDanger === 0 && sc.escalationSafetyRecall >= 0.9 && dangerRate <= 0.05;

  // ---- Panel 4: live control tower ----
  const t = s.tower;
  const maxFresh = Math.max(1, ...t.cycles.map((c) => c.freshFeeds));
  const towerRows = t.cycles
    .map((c) => {
      const w = Math.round((c.freshFeeds / maxFresh) * 100);
      const risky = c.openRisks > 0;
      return `<tr class="${c.decisions > 0 ? "hasdec" : ""}">
        <td class="num">${c.hour}h</td>
        <td><span class="spark"><span style="width:${w}%"></span></span> ${c.freshFeeds}</td>
        <td class="num">${c.maxLatencyMin}m</td>
        <td>${confBar(c.estConfidence)}</td>
        <td class="num ${risky ? "warn" : ""}">${c.openRisks}</td>
        <td class="num ${c.decisions ? "good" : ""}">${c.decisions || ""}</td>
      </tr>`;
    })
    .join("");
  const towerDecRows = t.decisions
    .map((d) => {
      const cls = d.outcome === "resolved" ? "resolved" : "escalated";
      return `<tr class="${cls}">
        <td class="num">${d.hour}h</td>
        <td><span class="badge ${cls}">${d.outcome}</span></td>
        <td>${esc(d.cell)}</td>
        <td>${esc(d.action)}</td>
        <td class="rationale">${esc(d.rationale)}</td>
        <td>${confBar(d.confidence)}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rally · Control Tower — ${esc(s.region)}</title>
<style>
  :root{--bg:#0b0f14;--panel:#131a22;--panel2:#0f151c;--ink:#e6edf3;--muted:#8b98a5;--line:#22303c;--accent:#4fd1c5;--good:#3fb950;--warn:#d29922;--bad:#f85149}
  @media (prefers-color-scheme: light){:root{--bg:#f5f7fa;--panel:#fff;--panel2:#f0f3f7;--ink:#0f1720;--muted:#5b6672;--line:#e2e8f0;--accent:#0d9488;--good:#1a7f37;--warn:#9a6700;--bad:#cf222e}}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  header{padding:20px 28px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
  header h1{font-size:20px;margin:0;letter-spacing:-.02em}
  header .tag{color:var(--muted);font-size:13px}
  header form{margin-left:auto;color:var(--muted)}
  header input{width:70px;background:var(--panel2);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:inherit}
  header button{background:var(--accent);color:#00201d;border:0;border-radius:6px;padding:5px 12px;font:inherit;font-weight:600;cursor:pointer}
  .grid{display:grid;grid-template-columns:1.05fr 1.35fr;gap:16px;padding:16px 28px 40px}
  .col{display:flex;flex-direction:column;gap:16px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .panel h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0;padding:14px 16px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center}
  .panel h2 .pill{margin-left:auto;font-size:11px;letter-spacing:.02em;text-transform:none;color:var(--muted)}
  .wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--muted);font-weight:500;padding:8px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel)}
  td{padding:7px 12px;border-bottom:1px solid var(--panel2)}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .sku{color:var(--muted)}
  .facrow td{font-weight:700;background:var(--panel2);color:var(--accent);letter-spacing:.02em}
  .rationale{color:var(--muted);max-width:340px}
  .badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600}
  .badge.ok{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good)}
  .badge.risk{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
  .badge.resolved{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good)}
  .badge.escalated{background:color-mix(in srgb,var(--warn) 20%,transparent);color:var(--warn)}
  tr.escalated td{background:color-mix(in srgb,var(--warn) 6%,transparent)}
  .cbar{display:inline-block;width:52px;height:7px;border-radius:4px;background:var(--panel2);overflow:hidden;vertical-align:middle;margin-right:6px}
  .cbar>span{display:block;height:100%}
  .cnum{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px}
  .good{color:var(--good)} .warn{color:var(--warn)} .bad{color:var(--bad);font-weight:700}
  .mark{font-weight:700} .mark.good{color:var(--good)} .mark.bad{color:var(--bad)}
  .tower{margin:0 28px 40px}
  .towergrid{display:grid;grid-template-columns:1fr 1.4fr;gap:0}
  .towergrid>div{border-right:1px solid var(--line)} .towergrid>div:last-child{border-right:0}
  .subh{padding:10px 14px;color:var(--muted);font-size:12px;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--panel2)}
  tr.hasdec td{background:color-mix(in srgb,var(--accent) 7%,transparent)}
  .spark{display:inline-block;width:60px;height:8px;border-radius:3px;background:var(--panel2);overflow:hidden;vertical-align:middle;margin-right:6px}
  .spark>span{display:block;height:100%;background:var(--accent)}
  @media (max-width:920px){.towergrid{grid-template-columns:1fr}.tower{margin:0 16px 24px}}
  .metrics{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line)}
  .metric{background:var(--panel);padding:12px 16px}
  .metric .k{color:var(--muted);font-size:12px}
  .metric .v{font-size:20px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .verdict{padding:14px 16px;font-weight:600;display:flex;gap:10px;align-items:center}
  .verdict.safe{color:var(--good)} .verdict.unsafe{color:var(--bad)}
  .note{padding:10px 16px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}
  @media (max-width:920px){.grid{grid-template-columns:1fr}}
</style></head><body>
<header>
  <h1>Rally <span style="color:var(--accent)">·</span> Supply-Chain Control Tower</h1>
  <span class="tag">${esc(s.region)} — decision-first: resolve autonomously, escalate only what it should</span>
  <form method="get"><label>seed <input name="seed" value="${seed}"></label> <button>run</button></form>
</header>
<div class="grid">
  <div class="col">
    <section class="panel">
      <h2>① State layer — track &amp; trace <span class="pill">estimated @ ${s.atHour}h · conf ${s.estimated.overallConfidence} · drift ≤ ${s.drift.maxAbs.toFixed(0)}u</span></h2>
      <div class="wrap"><table>
        <thead><tr><th>sku</th><th class="num">on-hand</th><th class="num">available</th><th>status</th><th>confidence</th></tr></thead>
        <tbody>${stateRows}</tbody>
      </table></div>
      <div class="note">Reconstructed from ${s.feedCount.toLocaleString()} sensor-shaped feed messages. Confidence falls with snapshot lag and sequence gaps — the eyes report how well they can see.</div>
    </section>
    <section class="panel">
      <h2>In-transit assets <span class="pill">movement → shipment association</span></h2>
      <div class="wrap"><table>
        <thead><tr><th>asset</th><th>shipment</th><th>at</th><th>confidence</th></tr></thead>
        <tbody>${assetRows || '<tr><td colspan="4" class="note">no trucks in transit at this hour</td></tr>'}</tbody>
      </table></div>
    </section>
  </div>

  <div class="col">
    <section class="panel">
      <h2>② Decision queue <span class="pill">${nResolved} resolved · ${nEscalated} escalated · sample of ${sc.disruptions} graded decisions</span></h2>
      <div class="wrap"><table>
        <thead><tr><th>exception</th><th>disposition</th><th>action</th><th>rationale</th><th class="num">impact</th><th>conf</th></tr></thead>
        <tbody>${decRows || '<tr><td colspan="6" class="note">no risks in this run</td></tr>'}</tbody>
      </table></div>
      <div class="note">A ✓ means the grader (closed-world oracle) confirmed the disposition was right; ✗ marks the surfaced failure modes — over-caution or, worse, a claimed fix that still missed.</div>
    </section>

    <section class="panel">
      <h2>③ Escalation scorecard <span class="pill">${sc.seeds.length} seeds · ${sc.disruptions} disruptions</span></h2>
      <div class="wrap"><table>
        <thead><tr><th>type</th><th class="num">touchless</th><th class="num">T-Resolve</th><th class="num">T-Escal</th><th class="num">F-Escal</th><th class="num">F-Resolve</th></tr></thead>
        <tbody>${typeRows}</tbody>
      </table></div>
      <div class="metrics">
        <div class="metric"><div class="k">touchless (resolvable)</div><div class="v">${pct(resolvableTouchless(s))}</div></div>
        <div class="metric"><div class="k">escalation safety recall</div><div class="v">${pct(sc.escalationSafetyRecall)}</div></div>
        <div class="metric"><div class="k">escalation precision</div><div class="v">${pct(sc.escalationPrecision)}</div></div>
        <div class="metric"><div class="k">confidence calibration</div><div class="v">${sc.calibration.toFixed(2)}</div></div>
        <div class="metric"><div class="k">value captured (units)</div><div class="v good">${sc.valueCaptured.toLocaleString()}</div></div>
        <div class="metric"><div class="k">value forgone to caution</div><div class="v warn">${sc.valueForgone.toLocaleString()}</div></div>
      </div>
      <div class="verdict ${safe ? "safe" : "unsafe"}">${safe ? "✅" : "❌"} injected-unresolvable falsely resolved: ${injectedDanger} · dangerous rate ${pct(dangerRate)}</div>
      <div class="note">The finding is the matrix, not a single number. False Resolve (claimed a fix, service still missed) is the dangerous cell and is weighted accordingly.</div>
    </section>
  </div>
</div>

<section class="panel tower">
  <h2>④ Live control tower — ingest → estimate → detect → resolve <span class="pill">${t.resolved} resolved · ${t.escalated} escalated · coverage ${t.caught}/${t.truth}</span></h2>
  <div class="towergrid">
    <div>
      <div class="subh">operations (per ${18}h cycle)</div>
      <div class="wrap" style="max-height:320px;overflow-y:auto"><table>
        <thead><tr><th class="num">t</th><th>fresh feeds</th><th class="num">lag</th><th>est&nbsp;conf</th><th class="num">open</th><th class="num">dec</th></tr></thead>
        <tbody>${towerRows}</tbody>
      </table></div>
    </div>
    <div>
      <div class="subh">decision log</div>
      <div class="wrap"><table>
        <thead><tr><th class="num">t</th><th>outcome</th><th>cell</th><th>action</th><th>rationale</th><th>conf</th></tr></thead>
        <tbody>${towerDecRows || '<tr><td colspan="6" class="note">no risks surfaced yet</td></tr>'}</tbody>
      </table></div>
    </div>
  </div>
  <div class="note">The whole system, running on sensor-grounded state: each cycle ingests fresh feeds from every source (incrementally), re-estimates state, detects projected stockouts on the estimate, and resolves or escalates — decision-first, end to end.</div>
</section>
</body></html>`;
}

function resolvableTouchless(s: Showcase): number {
  const resolvable = s.records.filter((r) => r.resolvableTruth);
  return resolvable.length ? resolvable.filter((r) => r.cell === "trueResolve").length / resolvable.length : 0;
}

// The render is deterministic per seed and a few seconds of CPU, so cache it.
const cache = new Map<number, string>();
async function renderCached(seed: number): Promise<string> {
  const hit = cache.get(seed);
  if (hit) return hit;
  const html = await render(seed);
  if (cache.size > 32) cache.clear(); // bound the cache
  cache.set(seed, html);
  return html;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (url.pathname !== "/") {
    res.writeHead(404).end("not found");
    return;
  }
  const seed = Number(url.searchParams.get("seed") ?? 4000) || 4000;
  renderCached(seed)
    .then((html) => res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" }).end(html))
    .catch((err) => res.writeHead(500).end(`error: ${(err as Error).message}`));
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Rally control tower → http://0.0.0.0:${PORT}`);
  // Warm the default view so the first real request is instant.
  renderCached(4000).catch(() => {});
});
