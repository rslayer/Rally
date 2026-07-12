/**
 * A faithful, generic mock of a cursor-paginated vendor API — enough of the real
 * contract to develop and CI-test any connector without credentials: bearer
 * auth, time-windowed cursor pagination, and an optional one-shot 429 to
 * exercise retry/backoff. Domain-agnostic (rows just need a `time`), so it
 * doubles as the reusable test double for every connector.
 */

import { createServer, type Server, type ServerResponse } from "node:http";

export interface MockApiOptions<Row extends { time: string }> {
  token: string;
  path: string; // the endpoint the connector calls, e.g. "/wms/transactions"
  rows: Row[];
  pageSize?: number;
  injectRateLimitOnce?: boolean;
}

export interface MockHandle {
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

export function startMockApi<Row extends { time: string }>(opts: MockApiOptions<Row>): Promise<MockHandle> {
  const pageSize = opts.pageSize ?? 100;
  const sorted = [...opts.rows].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  let requests = 0;
  let rateLimitPending = opts.injectRateLimitOnce ?? false;

  const server: Server = createServer((req, res) => {
    requests++;
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname !== opts.path) return send(res, 404, { message: "not found" });
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
    const filtered = sorted.filter((r) => {
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
