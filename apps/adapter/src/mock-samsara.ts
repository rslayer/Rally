/**
 * Standalone mock Samsara API, seeded from the canonical recorded episode.
 *
 *   npm run mock-samsara   # then point RALLY_SAMSARA_BASE_URL at the printed URL
 *
 * The server itself lives in @rally/importers (domain-only, reusable as a test
 * double); here we just seed it with real-shaped GPS rows from a sim episode.
 */

import { startMockSamsara, feedsToRows } from "@rally/importers";
import type { SamsaraLocationRow } from "@rally/importers";
import { recordEpisode } from "@rally/simulation";
import { EPISODE_DISRUPTION, EPISODE_SEED } from "@rally/data-gen";

export { startMockSamsara };

export function episodeRows(): SamsaraLocationRow[] {
  return feedsToRows(recordEpisode(EPISODE_SEED, EPISODE_DISRUPTION).feeds);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const token = process.env.RALLY_SAMSARA_TOKEN ?? "demo-token";
  startMockSamsara({ token, rows: episodeRows(), pageSize: 100 }).then((h) => {
    console.log(`mock Samsara API → ${h.url}  (token: ${token})`);
    console.log(`try:  curl -s -H "authorization: Bearer ${token}" "${h.url}/fleet/vehicles/locations?limit=2"`);
  });
}
