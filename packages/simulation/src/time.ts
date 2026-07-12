/** Sim-hour ↔ ISO timestamp. A fixed epoch keeps runs reproducible (no clock). */

export const SIM_EPOCH_MS = Date.UTC(2026, 0, 5, 0, 0, 0); // Mon 2026-01-05 00:00Z

export function hourToIso(hour: number): string {
  return new Date(SIM_EPOCH_MS + hour * 3600_000).toISOString();
}

export function isoToHour(iso: string): number {
  return Math.round((new Date(iso).getTime() - SIM_EPOCH_MS) / 3600_000);
}
