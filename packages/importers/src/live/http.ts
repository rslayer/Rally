/**
 * Minimal, dependency-free HTTP-JSON client for live vendor connectors.
 *
 * Handles the things every real integration must: bearer auth, per-request
 * timeouts, and retry-with-backoff on 429 / 5xx (honoring `Retry-After`). Auth
 * failures are NOT retried — a bad token won't fix itself. Tokens are read from
 * the environment by the caller and passed in; nothing is ever hardcoded.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
    this.name = "HttpError";
  }
}

export interface FetchOptions {
  token: string;
  maxRetries?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  /** Called on each retry (rate-limit or transient) for telemetry. */
  onRetry?: (info: { attempt: number; status: number | "network"; waitMs: number }) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const { token, maxRetries = 4, timeoutMs = 10_000, backoffBaseMs = 100, onRetry } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 401 || res.status === 403) {
        throw new HttpError(res.status, "unauthorized — check the vendor API token");
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxRetries) throw new HttpError(res.status, `giving up after ${maxRetries} retries`);
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : backoffBaseMs * 2 ** attempt;
        onRetry?.({ attempt, status: res.status, waitMs });
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => res.statusText));
      return (await res.json()) as T;
    } catch (err) {
      // Never retry an auth failure.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw err;
      lastErr = err;
      if (attempt >= maxRetries) break;
      // Transient network / timeout error → backoff and retry.
      const waitMs = backoffBaseMs * 2 ** attempt;
      onRetry?.({ attempt, status: "network", waitMs });
      await sleep(waitMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed");
}
