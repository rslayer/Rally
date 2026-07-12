/**
 * Multi-source ingestion demo — the whole eyes layer as one unit.
 *
 * Runs a telematics connector (Samsara-shaped) and a WMS connector
 * (EDI-945-shaped) through the orchestrator, each with its OWN incremental
 * watermark, merges the fresh events with batch ERP inventory, and hands the
 * fused stream to the estimator. Rebuilds the orchestrator from disk mid-run to
 * prove per-source resume, and asserts exactly-once delivery per source.
 *
 *   npm run orchestrate
 */

import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SamsaraClient, WmsClient, IngestionOrchestrator, ingestFeedBatch,
  feedsToRows, feedsToWmsRows, startMockSamsara, startMockWms,
  type PullFn, type Source,
} from "@rally/importers";
import { recordEpisode, estimateState, hourToIso } from "@rally/simulation";
import { EPISODE_DISRUPTION, EPISODE_SEED, TX_OK_NETWORK } from "@rally/data-gen";
import { FileSyncStore } from "./file-sync-store.js";

const token = process.env.RALLY_SAMSARA_TOKEN ?? "demo-token";
const dir = fileURLToPath(new URL("../../../.rally/sync", import.meta.url));
const telematicsState = `${dir}/telematics.json`;
const wmsState = `${dir}/wms.json`;

async function main(): Promise<void> {
  const feeds = recordEpisode(EPISODE_SEED, EPISODE_DISRUPTION).feeds;
  const movementRows = feedsToRows(feeds);
  const wmsRows = feedsToWmsRows(feeds);
  const inventoryFeeds = feeds.filter((m) => m.feedType === "inventory_snapshot"); // batch ERP extract

  const samsaraMock = await startMockSamsara({ token, rows: movementRows, pageSize: 100 });
  const wmsMock = await startMockWms({ token, rows: wmsRows, pageSize: 200 });
  const samsara = new SamsaraClient({ baseUrl: samsaraMock.url, token, pageLimit: 100 });
  const wms = new WmsClient({ baseUrl: wmsMock.url, token, pageLimit: 200 });

  const samsaraPull: PullFn = (s, u) => samsara.backfill(s, u).then((r) => r.feeds);
  const wmsPull: PullFn = (s, u) => wms.backfill(s, u).then((r) => r.feeds);

  rmSync(telematicsState, { force: true });
  rmSync(wmsState, { force: true });
  const makeSources = (): Source[] => [
    { name: "telematics", pull: samsaraPull, store: new FileSyncStore(telematicsState) },
    { name: "wms", pull: wmsPull, store: new FileSyncStore(wmsState) },
  ];
  let orch = new IngestionOrchestrator(makeSources(), { lookbackHours: 6 });

  const bar = "─".repeat(76);
  console.log("\nRALLY · multi-source ingestion — telematics + WMS, one merged stream");
  console.log(bar);
  console.log("cycle  clock   telematics(fresh/dup)   wms(fresh/dup)   merged");

  const merged: typeof feeds = [];
  const totals = { telematics: 0, wms: 0 };
  const runCycle = async (label: string, untilHour: number) => {
    const { fresh, bySource } = await orch.runCycle(hourToIso(untilHour));
    merged.push(...fresh);
    const t = bySource.find((s) => s.source === "telematics")!;
    const w = bySource.find((s) => s.source === "wms")!;
    totals.telematics += t.fresh;
    totals.wms += w.fresh;
    console.log(
      `${label.padEnd(6)} ${(untilHour + "h").padStart(5)}   ${`${t.fresh}/${t.duplicates}`.padStart(18)}   ${`${w.fresh}/${w.duplicates}`.padStart(13)}   ${String(fresh.length).padStart(6)}`,
    );
  };

  await runCycle("1", 48);
  await runCycle("2", 96);
  console.log(`${"".padEnd(6)}   ·· restart: orchestrator rebuilt from .rally/sync/*.json ··`);
  orch = new IngestionOrchestrator(makeSources(), { lookbackHours: 6 });
  await runCycle("3", 168);
  await runCycle("4", 336);

  // Fuse the live streams with batch ERP inventory and reconstruct state.
  const { messages } = ingestFeedBatch([...merged, ...inventoryFeeds]);
  const { state, drift } = estimateState(messages, 108, TX_OK_NETWORK);

  console.log(bar);
  const okT = totals.telematics === movementRows.length;
  const okW = totals.wms === wmsRows.length;
  console.log(`exactly-once             telematics ${totals.telematics}/${movementRows.length} ${okT ? "✓" : "✗"} · wms ${totals.wms}/${wmsRows.length} ${okW ? "✓" : "✗"}`);
  console.log(`fused feeds              ${messages.length} (live telematics + live WMS + batch ERP)`);
  console.log(`estimated @ 108h         confidence ${state.overallConfidence} · drift ≤ ${drift.maxAbs.toFixed(0)}u · ${state.assets.length} assets`);
  console.log(`${okT && okW ? "✅" : "❌"} two live sources, independent watermarks, one merged stream into the estimator.\n`);

  await samsaraMock.close();
  await wmsMock.close();
  process.exit(okT && okW ? 0 : 1);
}

main().catch((err) => {
  console.error("orchestrate failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
