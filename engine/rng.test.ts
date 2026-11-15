import { describe, expect, it } from "vitest";
import { createRng, rngFromState, seedToUint32 } from "./rng";

const draw = (seed: number | string, n: number) => {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next());
};

describe("seeded rng", () => {
  it("same seed gives the identical sequence", () => {
    expect(draw(42, 10_000)).toEqual(draw(42, 10_000));
    expect(draw("storm-day", 10_000)).toEqual(draw("storm-day", 10_000));
  });

  it("different seeds give different sequences", () => {
    expect(draw(1, 20)).not.toEqual(draw(2, 20));
    expect(draw("a", 20)).not.toEqual(draw("b", 20));
  });

  it("sequence is pinned, so an accidental algorithm change fails loudly", () => {
    expect(draw(42, 5)).toMatchInlineSnapshot(`
      [
        0.6011037519201636,
        0.44829055899754167,
        0.8524657934904099,
        0.6697340414393693,
        0.17481389874592423,
      ]
    `);
  });

  it("mixed calls (int, chance, pick) replay identically", () => {
    const run = () => {
      const rng = createRng(7);
      const out: unknown[] = [];
      for (let i = 0; i < 1000; i++) {
        out.push(rng.int(0, 19), rng.chance(0.3), rng.pick(["hotspot", "soiling", "string_outage", "tracker_stuck"]));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it("next() stays in [0, 1) and is roughly uniform", () => {
    const values = draw(123, 50_000);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.49);
    expect(mean).toBeLessThan(0.51);
  });

  it("int() covers the whole inclusive range and nothing else", () => {
    const rng = createRng(9);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(rng.int(3, 8));
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("can resume from saved state", () => {
    const a = createRng(99);
    for (let i = 0; i < 500; i++) a.next();
    const b = rngFromState(a.state());
    const rest = (r: typeof a) => Array.from({ length: 500 }, () => r.next());
    expect(rest(b)).toEqual(rest(a));
  });

  it("rejects bad input", () => {
    expect(() => createRng(NaN)).toThrow();
    expect(() => createRng(1).int(5, 1)).toThrow();
    expect(() => createRng(1).pick([])).toThrow();
    expect(seedToUint32("arien")).toBe(seedToUint32("arien"));
  });
});
