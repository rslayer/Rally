/**
 * Generate vendor-shaped export fixtures on disk from a recorded episode.
 *
 * These are the files a real customer would hand you — a telematics GPS dump, a
 * WMS transaction log, an ERP on-hand extract — plus the observed physical
 * outcome the backtest checks the simulator reproduces.
 *
 *   npm run fixtures
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordEpisode } from "@rally/simulation";
import { feedsToVendorFiles } from "@rally/importers";
import { EPISODE_DISRUPTION, EPISODE_SEED } from "@rally/data-gen";

const dir = fileURLToPath(new URL("../../../fixtures/real-feed", import.meta.url));
mkdirSync(dir, { recursive: true });

const episode = recordEpisode(EPISODE_SEED, EPISODE_DISRUPTION);
const files = feedsToVendorFiles(episode.feeds);

writeFileSync(`${dir}/telematics.csv`, files.telematics);
writeFileSync(`${dir}/wms.csv`, files.wms);
writeFileSync(`${dir}/inventory.json`, files.inventory);
writeFileSync(`${dir}/asn.json`, files.asn);
writeFileSync(`${dir}/ops.json`, files.ops);

// The observed physical outcome (no feeds — those are the vendor files above).
const observed = {
  seed: episode.seed,
  disruption: episode.disruption,
  horizonHours: episode.horizonHours,
  probeHours: episode.probeHours,
  truth: episode.truth,
  exceptions: episode.exceptions,
  stockoutHours: episode.stockoutHours,
};
writeFileSync(`${dir}/observed.json`, JSON.stringify(observed, null, 2) + "\n");

const counts = episode.feeds.reduce<Record<string, number>>((a, m) => ((a[m.feedType] = (a[m.feedType] ?? 0) + 1), a), {});
console.log(`Wrote vendor fixtures to ${dir}`);
console.log(`  telematics.csv   ${counts.movement ?? 0} GPS pings`);
console.log(`  wms.csv          ${counts.warehouse ?? 0} transactions`);
console.log(`  inventory.json   ${counts.inventory_snapshot ?? 0} on-hand extracts`);
console.log(`  asn.json         ${counts.asn ?? 0} advance ship notices`);
console.log(`  observed.json    ${episode.truth.length} truth samples · ${episode.exceptions.length} exceptions · ${episode.stockoutHours} stockout-hours`);
