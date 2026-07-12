/** File-backed SyncStore — persists incremental-sync state as JSON on disk, so a
 *  poller resumes across process restarts. Writes atomically (temp + rename). */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SyncState, SyncStore } from "@rally/importers";
import { emptySyncState } from "@rally/importers";

export class FileSyncStore implements SyncStore {
  constructor(private readonly path: string) {}

  load(): SyncState {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as SyncState;
    } catch {
      return emptySyncState();
    }
  }

  save(state: SyncState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.path); // atomic swap — never leaves a half-written file
  }
}
