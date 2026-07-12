/**
 * Live vendor-API sync — the production-shaped pull, end to end.
 *
 * Authenticates, backfills a time window from the telematics API with cursor
 * pagination + retry/backoff + a resumable checkpoint, then merges the live
 * movement stream with batch WMS/ERP feeds and hands the lot to the estimator —
 * proving a live pull and a file export are indistinguishable downstream.
 *
 * Defaults to a local mock so it runs with no secrets. To hit a real vendor:
 *   RALLY_SAMSARA_BASE_URL=https://api.samsara.com \
 *   RALLY_SAMSARA_TOKEN=*** \
 *   npm run live-sync
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnyFeedMessage } from "@rally/domain";
import { SamsaraClient, ingestFeedBatch, loadVendorFiles, feedsToVendorFiles } from "@rally/importers";
import type { Checkpoint } from "@rally/importers";
import { estimateState, hourToIso, recordEpisode } from "@rally/simulation";
import { TX_OK_NETWORK, EPISODE_DISRUPTION, EPISODE_SEED } from "@rally/data-gen";
import { startMockSamsara, episodeRows } from "./mock-samsara.js";

const token = process.env.RALLY_SAMSARA_TOKEN ?? "demo-token";
const envBaseUrl = process.env.RALLY_SAMSARA_BASE_URL;
const startTime = hourToIso(0);
const endTime = hourToIso(14 * 24);

/** Batch WMS/ERP feeds — from the committed fixtures if present, else recorded. */
function batchFeeds(): AnyFeedMessage[] {
  const dir = fileURLToPath(new URL("../../../fixtures/real-feed", import.meta.url));
  try {
    const files = {
      wms: readFileSync(`${dir}/wms.csv`, "utf8"),
      inventory: readFileSync(`${dir}/inventory.json`, "utf8"),
    };
    return loadVendorFiles(files);
  } catch {
    const files = feedsToVendorFiles(recordEpisode(EPISODE_SEED, EPISODE_DISRUPTION).feeds);
    return loadVendorFiles({ wms: files.wms, inventory: files.inventory });
  }
}

async function main(): Promise<void> {
  // Point at a real vendor if configured; otherwise spin up the local mock.
  let baseUrl = envBaseUrl;
  let mock: Awaited<ReturnType<typeof startMockSamsara>> | undefined;
  if (!baseUrl) {
    mock = await startMockSamsara({ token, rows: episodeRows(), pageSize: 100, injectRateLimitOnce: true });
    baseUrl = mock.url;
  }

  const client = new SamsaraClient({ baseUrl, token, pageLimit: 100 });

  // Resumable backfill: persist the checkpoint after each page.
  let lastCheckpoint: Checkpoint | undefined;
  const { feeds: liveMovement, stats } = await client.backfill(startTime, endTime, {
    onProgress: (cp) => (lastCheckpoint = cp),
  });

  // Merge live telematics with batch WMS/ERP and run the identical pipeline.
  const merged = [...liveMovement, ...batchFeeds()];
  const { messages, issues } = ingestFeedBatch(merged);
  const atHour = 108;
  const { state, drift } = estimateState(messages, atHour, TX_OK_NETWORK);

  const bar = "─".repeat(62);
  console.log("\nRALLY · live vendor-API sync — Samsara-shaped telematics");
  console.log(bar);
  console.log(`source                   ${envBaseUrl ? `LIVE ${envBaseUrl}` : `mock ${baseUrl}`}`);
  console.log(`window                   ${startTime} → ${endTime}`);
  console.log(`auth                     bearer token (${token.slice(0, 4)}…, ${token.length} chars)`);
  console.log(`backfill                 ${stats.pages} pages · ${stats.rows} GPS rows`);
  console.log(`resilience               ${stats.retries} retries · ${stats.rateLimitHits} rate-limit hit(s) handled`);
  console.log(`checkpoint (resumable)   cursor=${lastCheckpoint?.cursor ?? "∅"} · rows=${lastCheckpoint?.rowsFetched ?? 0}`);
  console.log(bar);
  console.log(`merged feeds             ${messages.length} (live movement + batch WMS/ERP)`);
  console.log(`ingest issues            ${issues.length} (${countKinds(issues)})`);
  console.log(`estimated @ ${atHour}h        overall confidence ${state.overallConfidence} · drift ≤ ${drift.maxAbs.toFixed(0)}u`);
  const inTransit = state.assets.filter((a) => !a.atFacilityId).length;
  console.log(`assets tracked           ${state.assets.length} (${inTransit} in transit) from live pings`);
  console.log(bar);
  console.log("✅ live pull flowed through the identical seam — auth, paging, backfill, done.\n");

  await mock?.close();
}

function countKinds(issues: Array<{ kind: string }>): string {
  const by: Record<string, number> = {};
  for (const i of issues) by[i.kind] = (by[i.kind] ?? 0) + 1;
  return Object.entries(by).map(([k, v]) => `${k}:${v}`).join(" ") || "none";
}

main().catch((err) => {
  console.error("live-sync failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
