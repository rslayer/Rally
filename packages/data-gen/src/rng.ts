/** Deterministic, seedable RNG. Reproducible by seed; no Math.random anywhere. */

export interface Rng {
  /** Uniform 0..1. */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Pick one element. */
  pick<T>(items: readonly T[]): T;
  /** Gaussian via Box–Muller, mean/stdev. */
  gaussian(mean: number, stdev: number): number;
}

/** mulberry32 — small, fast, good enough for simulation seeding. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error("pick from empty array");
      return items[Math.floor(next() * items.length)]!;
    },
    gaussian: (mean, stdev) => {
      const u = Math.max(1e-12, next());
      const v = next();
      return mean + stdev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
  return rng;
}
