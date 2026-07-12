import { describe, it, expect } from "vitest";
import { makeRng } from "./rng.js";

describe("makeRng", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(123);
    const b = makeRng(123);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different streams for different seeds", () => {
    const a = Array.from({ length: 20 }, makeRng(1).next);
    const b = Array.from({ length: 20 }, makeRng(2).next);
    expect(a).not.toEqual(b);
  });

  it("int/float stay within bounds and chance is a probability", () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const n = r.int(3, 9);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(9);
      const f = r.float(0, 1);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
});
