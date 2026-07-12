/** Small shared helpers for the kernel. */

import type { PositionCell, SimWorld } from "./types.js";

export function cellKey(facilityId: string, skuId: string): string {
  return `${facilityId}|${skuId}`;
}

export function available(cell: PositionCell): number {
  return Math.max(0, cell.onHandUnits - cell.allocatedUnits);
}

export function getCell(world: SimWorld, facilityId: string, skuId: string): PositionCell | undefined {
  return world.positions.get(cellKey(facilityId, skuId));
}
