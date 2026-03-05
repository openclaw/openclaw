export type SeedLike = string | number | boolean | null | undefined;

const DEFAULT_SEED = 0x1d2f3a4b;

const toUint32 = (value: SeedLike): number => {
  if (value === undefined || value === null) {
    return DEFAULT_SEED;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = value >>> 0;
    return normalized === 0 ? DEFAULT_SEED : normalized;
  }

  const str = String(value);
  let hash = 0x811c9dc5 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 15;
  }

  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash ^ (hash >>> 16), 0xc2b2ae35);

  return hash >>> 0 || DEFAULT_SEED;
};

const combineSeeds = (parts: SeedLike[]): number => {
  let seed = DEFAULT_SEED;
  for (const part of parts) {
    const value = toUint32(part);
    seed ^= value + 0x9e3779b9 + ((seed << 6) >>> 0) + (seed >>> 2);
    seed >>>= 0;
  }

  return seed >>> 0 || DEFAULT_SEED;
};

export interface SeededRandom {
  next: () => number;
  nextRange: (min: number, max: number) => number;
  nextInt: (min: number, max: number) => number;
  fork: (...parts: SeedLike[]) => SeededRandom;
}

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
};

export const createSeededRandom = (...parts: SeedLike[]): SeededRandom => {
  const baseSeed = combineSeeds(parts);
  const generator = mulberry32(baseSeed);

  const next = () => generator();
  const nextRange = (min: number, max: number) => {
    if (max < min) {
      throw new Error("max must be greater than or equal to min");
    }
    return next() * (max - min) + min;
  };
  const nextInt = (min: number, max: number) => {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new Error("nextInt expects integer bounds");
    }
    if (max < min) {
      throw new Error("max must be greater than or equal to min");
    }
    if (min === max) {
      return min;
    }
    return Math.floor(nextRange(min, max + 1));
  };

  const fork = (...moreParts: SeedLike[]): SeededRandom =>
    createSeededRandom(baseSeed, ...moreParts);

  return {
    next,
    nextRange,
    nextInt,
    fork,
  };
};
