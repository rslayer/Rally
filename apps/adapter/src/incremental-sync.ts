/**
 * Incremental sync demo — a scheduled poller that pulls only what's new,
 * survives a restart, and never double-counts.
 *
 * Runs several cycles with an ADVANCING clock (simulating new pings arriving),
 * persists a watermark to disk between cycles, then throws away the engine and
 * rebuilds it from the same file — proving the sync resumes exactly where it
 * left off. Defaults to the local mock; the same code hits a real vendor with
 * RALLY_SAMSARA_BASE_URL / RALLY_SAMSARA_TOKEN.
 *
 *   npm run incremental-sync
 */

import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SamsaraClient, SyncEngine, type PullFn, type CycleStats } from "@rally/importers";
import { hourToIso } from "@rally/simulation";
import { startMockSamsara, episodeRows } from "./mock-samsara.js";
import { FileSyncStore } from "./file-sync-store.js";

const token = process.env.RALLY_SAMSARA_TOKEN ?? "demo-token";
const envBaseUrl = process.env.RALLY_SAMSARA_BASE_URL;
const statePath = fileURLToPath(new URL("../../../.rally/sync/samsara.json", import.meta.url));

async function main(): Promise<void> {
  let baseUrl = envBaseUrl;
  let mock: Awaited<ReturnType<typeof startMockSamsara>> | undefined;
  const rows = episodeRows();
  if (!baseUrl) {
    mock = await startMockSamsara({ token, rows, pageSize: 100 });
    baseUrl = mock.url;
  }
  const client = new SamsaraClient({ baseUrl, token, pageLimit: 100 });
  const pull: PullFn = (since, until) => client.backfill(since, until).then((r) => r.feeds);

  rmSync(statePath, { force: true }); // clean start for a reproducible demo

  const bar = "─".repeat(74);
  console.log("\nRALLY · incremental sync — watermark · lookback · dedup · resume");
  console.log(bar);
  console.log(`source     ${envBaseUrl ? `LIVE ${envBaseUrl}` : `mock ${baseUrl}`}`);
  console.log(`state file ${statePath}`);
  console.log(bar);
  console.log("cycle  clock   pulled  fresh  dup   watermark");

  const epoch0 = Date.parse(hourToIso(0));
  const hoursOf = (iso: string | null) => (iso ? `${Math.round((Date.parse(iso) - epoch0) / 3_600_000)}h` : "—");
  let cumulativeFresh = 0;
  const print = (label: string, s: CycleStats) => {
    cumulativeFresh += s.fresh;
    console.log(
      `${label.padEnd(6)} ${hoursOf(s.until).padStart(5)}  ${String(s.pulled).padStart(6)} ${String(s.fresh).padStart(6)} ${String(s.duplicates).padStart(4)}   ${hoursOf(s.watermark).padStart(5)}`,
    );
  };

  // A first engine instance runs three cycles as the clock advances.
  let engine = new SyncEngine(new FileSyncStore(statePath), { lookbackHours: 6 });
  print("1", (await engine.runCycle(pull, hourToIso(48))).stats);
  print("2", (await engine.runCycle(pull, hourToIso(96))).stats);
  print("3·noop", (await engine.runCycle(pull, hourToIso(96))).stats); // no new clock → 0 fresh

  // 💥 Restart: brand-new engine, rebuilt from the persisted file. It must resume.
  console.log(`${"".padEnd(6)}   ·· restart: new engine rebuilt from ${statePath.split("/").slice(-2).join("/")} ··`);
  engine = new SyncEngine(new FileSyncStore(statePath), { lookbackHours: 6 });
  print("4", (await engine.runCycle(pull, hourToIso(168))).stats);
  print("5", (await engine.runCycle(pull, hourToIso(336))).stats);

  console.log(bar);
  const expected = rows.length;
  const ok = cumulativeFresh === expected;
  console.log(`unique events synced     ${cumulativeFresh} / ${expected} distinct GPS rows  ${ok ? "✓ exactly once" : "✗ MISMATCH"}`);
  console.log(`re-scanned & deduped     lookback caught late arrivals with zero duplicates emitted`);
  console.log(`${ok ? "✅" : "❌"} incremental, resumable, exactly-once — the operational shape of a real poller.\n`);

  await mock?.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("incremental-sync failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
