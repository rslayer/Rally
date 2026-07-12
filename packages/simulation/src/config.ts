/** Default SimConfig factory for the Texas–Oklahoma fixture. */

import type { Disruption, ResolutionAction } from "@rally/domain";
import { DEFAULT_POLICY } from "@rally/domain";
import { TX_OK_NETWORK, buildDemandModel } from "@rally/data-gen";
import type { SimConfig } from "./types.js";

export interface ScenarioOptions {
  seed: number;
  horizonHours?: number;
  disruptions?: Disruption[];
  resolverEnabled?: boolean;
  emitFeeds?: boolean;
  forceAction?: ResolutionAction;
}

export function makeConfig(opts: ScenarioOptions): SimConfig {
  const network = TX_OK_NETWORK;
  return {
    network,
    demandModel: buildDemandModel(network),
    horizonHours: opts.horizonHours ?? 14 * 24,
    seed: opts.seed,
    disruptions: opts.disruptions ?? [],
    policy: DEFAULT_POLICY,
    resolverEnabled: opts.resolverEnabled ?? false,
    orderBucketHours: 6,
    cover: { initialDays: 3, reorderDays: 2.0, orderUpToDays: 3.5 },
    emitFeeds: opts.emitFeeds ?? false,
    ...(opts.forceAction ? { forceAction: opts.forceAction } : {}),
  };
}
