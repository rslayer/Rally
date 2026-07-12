/**
 * Persistent state for an incremental sync: the high-water mark reached and a
 * bounded set of recently-seen event keys (for de-duplication across the
 * re-scan lookback window). The store is a tiny interface so the engine stays
 * agnostic to WHERE state lives — memory in tests, a file on disk in the CLI, a
 * row in a real deployment.
 */

export interface SyncState {
  /** Max emittedAt processed so far (ISO), or null before the first cycle. */
  watermark: string | null;
  /** Recently-seen `feedId#sequence` keys → emittedAt epoch-ms, bounded to the
   *  lookback window so the set can't grow without bound. */
  seen: Array<[string, number]>;
}

export interface SyncStore {
  load(): SyncState;
  save(state: SyncState): void;
}

export function emptySyncState(): SyncState {
  return { watermark: null, seen: [] };
}

/** In-memory store — for tests and ephemeral runs. */
export class MemorySyncStore implements SyncStore {
  private state: SyncState = emptySyncState();
  load(): SyncState {
    return this.state;
  }
  save(state: SyncState): void {
    this.state = state;
  }
}
