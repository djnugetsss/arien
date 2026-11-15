// Seeded random number generator (mulberry32). The only source of randomness
// in the engine: same seed in, same sequence out, on every machine.

export type Seed = number | string;

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** True with probability p (0..1). */
  chance(p: number): boolean;
  /** One item from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Internal state. Save it to resume the exact same sequence later (playback). */
  state(): number;
}

/** Turns a number or string seed into a 32-bit unsigned int (FNV-1a for strings). */
export function seedToUint32(seed: Seed): number {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) throw new Error(`Seed must be finite, got ${seed}`);
    return Math.floor(seed) >>> 0;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: Seed): Rng {
  return rngFromState(seedToUint32(seed));
}

/** Rebuilds an RNG from a value returned by `rng.state()`. */
export function rngFromState(state: number): Rng {
  let a = state >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new Error(`Bad int range: [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(items) {
      if (items.length === 0) throw new Error("Cannot pick from an empty list");
      return items[Math.floor(next() * items.length)];
    },
    state() {
      return a;
    },
  };
}
