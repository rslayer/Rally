/**
 * A faithful in-process mock of the Samsara fleet API — enough of the real
 * contract to develop and CI-test the live connector without any credentials:
 * bearer auth, cursor pagination over a time window, and an optional one-shot
 * 429 to exercise retry/backoff. Domain-only deps, so it doubles as a reusable
 * test fixture for the connector.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AnyFeedMessage, MovementEvent } from "@rally/domain";
import type { SamsaraLocationRow } from "./samsara.js";

/** Movement feed envelopes → Samsara-shaped GPS rows. */
export function feedsToRows(feeds: AnyFeedMessage[]): SamsaraLocationRow[] {
  const rows: SamsaraLocationRow[] = [];
  for (const m of feeds) {
    if (m.feedType !== "movement") continue;
    const p = m.payload as MovementEvent;
    rows.push({
      sequence: m.sequence,
      time: m.emittedAt,
      receivedAt: m.ingestedAt,
      vehicle: { id: p.assetId },
      latitude: p.location.lat,
      longitude: p.location.lon,
      speedMilesPerHour: p.speedMph,
      headingDegrees: p.headingDeg,
      ...(p.shipmentRef ? { shipmentRef: p.shipmentRef } : {}),
      ...(p.geofenceId && p.geofenceTransition ? { geofence: { id: p.geofenceId, event: p.geofenceTransition } } : {}),
    });
  }
  return rows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.sequence - b.sequence);
}

export interface MockOptions {
  token: string;
  rows: SamsaraLocationRow[];
  pageSize?: number;
  injectRateLimitOnce?: boolean;
}

export interface MockHandle {
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

export function startMockSamsara(opts: MockOptions): Promise<MockHandle> {
  const pageSize = opts.pageSize ?? 100;
  let requests = 0;
  let rateLimitPending = opts.injectRateLimitOnce ?? false;

  const server: Server = createServer((req, res) => {
    requests++;
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname !== "/fleet/vehicles/locations") return send(res, 404, { message: "not found" });
    if (req.headers.authorization !== `Bearer ${opts.token}`) {
      return send(res, 401, { message: "invalid or missing bearer token" });
    }
    if (rateLimitPending) {
      rateLimitPending = false;
      res.setHeader("retry-after", "0");
      return send(res, 429, { message: "rate limit exceeded" });
    }

    const startTime = url.searchParams.get("startTime") ?? "";
    const endTime = url.searchParams.get("endTime") ?? "";
    const limit = Math.min(pageSize, Number(url.searchParams.get("limit") ?? pageSize) || pageSize);
    const after = url.searchParams.get("after");
    const offset = after ? Number(after.replace(/^off:/, "")) || 0 : 0;

    const lo = startTime ? Date.parse(startTime) : -Infinity;
    const hi = endTime ? Date.parse(endTime) : Infinity;
    const filtered = opts.rows.filter((r) => {
      const t = Date.parse(r.time);
      return t >= lo && t <= hi;
    });

    const slice = filtered.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const hasNextPage = nextOffset < filtered.length;
    send(res, 200, { data: slice, pagination: { hasNextPage, endCursor: hasNextPage ? `off:${nextOffset}` : null } });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requestCount: () => requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
