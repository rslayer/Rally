/**
 * Real-feed adapter demo — the seam, end to end, from files on disk.
 *
 * Reads vendor-shaped exports (telematics CSV, WMS log, ERP extract), runs them
 * through the SAME ingestion + estimation path the synthetic generator uses, and
 * prints the reconstructed state plus the data-quality issues a real pipeline
 * would flag (sequence gaps, lateness). Nothing downstream knows the difference.
 *
 *   npm run fixtures   # once, to create the files
 *   npm run adapter    # ingest them
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadVendorFiles, ingestFeedBatch } from "@rally/importers";
import { estimateState } from "@rally/simulation";
import { TX_OK_NETWORK } from "@rally/data-gen";

const dir = fileURLToPath(new URL("../../../fixtures/real-feed", import.meta.url));

function read(name: string): string {
  try {
    return readFileSync(`${dir}/${name}`, "utf8");
  } catch {
    console.error(`Missing ${dir}/${name}. Run \`npm run fixtures\` first.`);
    process.exit(1);
  }
}

const files = {
  telematics: read("telematics.csv"),
  wms: read("wms.csv"),
  inventory: read("inventory.json"),
};

// 1) Parse vendor files → the shared FeedEnvelope stream.
const feeds = loadVendorFiles(files);

// 2) Validate + report data-quality issues, exactly as a real pipeline would.
const { messages, issues } = ingestFeedBatch(feeds);
const byKind = issues.reduce<Record<string, number>>((a, i) => ((a[i.kind] = (a[i.kind] ?? 0) + 1), a), {});

// 3) Estimate canonical state at a probe hour — track & trace as a READ.
const atHour = 108; // just after the modeled disruption peaks
const { state, drift } = estimateState(messages, atHour, TX_OK_NETWORK);

const bar = "─".repeat(60);
console.log("\nRALLY · real-feed adapter — vendor export → estimated state");
console.log(bar);
console.log(`ingested                 ${messages.length} messages (provenance: real)`);
console.log(`data-quality issues      ${issues.length}  ${Object.entries(byKind).map(([k, v]) => `${k}:${v}`).join("  ")}`);
console.log(`reconstructed @ ${atHour}h      overall confidence ${state.overallConfidence} · drift ≤ ${drift.maxAbs.toFixed(0)}u`);
console.log(bar);
console.log("facility   sku         on-hand   available   conf");
for (const p of state.positions) {
  if (!p.facilityId.startsWith("DC_")) continue;
  console.log(
    `${p.facilityId.padEnd(10)} ${p.skuId.padEnd(11)} ${String(p.onHandUnits).padStart(7)} ${String(p.availableUnits).padStart(11)}   ${p.confidence.toFixed(2)}`,
  );
}
const inTransit = state.assets.filter((a) => !a.atFacilityId).length;
console.log(bar);
console.log(`in-transit assets tracked ${inTransit} (movement→shipment association)`);
console.log("✅ real vendor exports flowed through the identical seam — downstream unchanged.\n");
