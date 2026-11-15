// Seeded fault generator. Each tick, each fault type gets one roll against its
// per-tick chance. On a hit we draw a location and a severity.
// All randomness comes from the Rng passed in, so the same seed gives the same faults.

import { advance, createClock, formatSimTime, type Clock } from "./clock";
import { createRng, type Rng, type Seed } from "./rng";
import { createSite, panelId, type Site } from "./site";

/** Fixed order. The generator rolls in this order every tick; changing it changes every run. */
export const FAULT_TYPES = ["hotspot", "soiling", "string_outage", "tracker_stuck"] as const;
export type FaultType = (typeof FAULT_TYPES)[number];

/** 1 = minor, 5 = critical. */
export type Severity = 1 | 2 | 3 | 4 | 5;

export interface FaultLocation {
  /** 0-based row. */
  row: number;
  /** 0-based first and last panel in the row, inclusive. Equal for a single panel. */
  colStart: number;
  colEnd: number;
  /** Center of the affected span, in site meters. This is where a worker has to go. */
  x: number;
  y: number;
}

export interface Fault {
  /** Sequential within a run: "F0001", "F0002", ... */
  id: string;
  type: FaultType;
  severity: Severity;
  location: FaultLocation;
  /** Tick the fault began on. */
  startTick: number;
}

export interface FaultConfig {
  /** Chance per tick, for the whole site, that a new fault of each type starts. */
  perTickChance: Record<FaultType, number>;
  /** Relative weights for severity 1..5, per type. */
  severityWeights: Record<FaultType, readonly [number, number, number, number, number]>;
  /** Soiling covers a run of this many panels in one row. */
  soilingSpan: { min: number; max: number };
  /** Panels wired together in one string. A string outage takes out one whole string. */
  panelsPerString: number;
}

export const DEFAULT_FAULT_CONFIG: FaultConfig = {
  // ASSUMPTION: demo-tuned rates, not field data. They give roughly 27 faults per
  // 1,000 ticks so the log is readable. Real sites fault far less often per minute.
  perTickChance: {
    hotspot: 0.012, // ASSUMPTION: most common fault in the demo
    soiling: 0.008, // ASSUMPTION
    string_outage: 0.004, // ASSUMPTION
    tracker_stuck: 0.003, // ASSUMPTION: rarest in the demo
  },
  // ASSUMPTION: severity mixes are guesses. Hotspots and soiling skew minor,
  // string outages and stuck trackers skew serious because they hit more panels.
  severityWeights: {
    hotspot: [30, 30, 20, 15, 5], // ASSUMPTION
    soiling: [40, 35, 20, 5, 0], // ASSUMPTION: soiling is never critical
    string_outage: [0, 10, 30, 40, 20], // ASSUMPTION
    tracker_stuck: [0, 15, 40, 35, 10], // ASSUMPTION
  },
  soilingSpan: { min: 3, max: 12 }, // ASSUMPTION: a dirty patch covers 3 to 12 panels
  panelsPerString: 20, // ASSUMPTION: 20 panels per string, so 2 strings per 40-panel row
};

export interface FaultGenerator {
  /** Returns the faults that start on this tick (usually none). Call once per tick, in order. */
  step(tick: number): Fault[];
}

function validateConfig(config: FaultConfig): void {
  for (const type of FAULT_TYPES) {
    const p = config.perTickChance[type];
    if (!(p >= 0 && p <= 1)) throw new Error(`perTickChance.${type} must be in [0, 1], got ${p}`);
    const weights = config.severityWeights[type];
    if (weights.some((w) => !(w >= 0)) || weights.every((w) => w === 0)) {
      throw new Error(`severityWeights.${type} needs non-negative weights with at least one above 0`);
    }
  }
  const { min, max } = config.soilingSpan;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error(`Bad soilingSpan: ${min}..${max}`);
  }
  if (!Number.isInteger(config.panelsPerString) || config.panelsPerString < 1) {
    throw new Error(`panelsPerString must be a whole number >= 1, got ${config.panelsPerString}`);
  }
}

function drawSeverity(rng: Rng, weights: readonly number[]): Severity {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return (i + 1) as Severity;
  }
  // Float rounding fallback: highest severity with a non-zero weight.
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return (i + 1) as Severity;
  return 1;
}

function span(site: Site, row: number, colStart: number, colEnd: number): FaultLocation {
  return {
    row,
    colStart,
    colEnd,
    x: ((colStart + colEnd) / 2) * site.panelSpacingM,
    y: row * site.rowPitchM,
  };
}

function drawLocation(rng: Rng, site: Site, type: FaultType, config: FaultConfig): FaultLocation {
  const row = rng.int(0, site.rows - 1);
  const lastCol = site.panelsPerRow - 1;
  switch (type) {
    case "hotspot": {
      // One panel.
      const col = rng.int(0, lastCol);
      return span(site, row, col, col);
    }
    case "soiling": {
      // A run of neighboring panels, clipped at the end of the row.
      const length = rng.int(config.soilingSpan.min, config.soilingSpan.max);
      const colStart = rng.int(0, lastCol);
      return span(site, row, colStart, Math.min(lastCol, colStart + length - 1));
    }
    case "string_outage": {
      // One whole string.
      const stringsInRow = Math.ceil(site.panelsPerRow / config.panelsPerString);
      const colStart = rng.int(0, stringsInRow - 1) * config.panelsPerString;
      return span(site, row, colStart, Math.min(lastCol, colStart + config.panelsPerString - 1));
    }
    case "tracker_stuck":
      // ASSUMPTION: one tracker drives one whole row.
      return span(site, row, 0, lastCol);
  }
}

export function createFaultGenerator(site: Site, rng: Rng, overrides: Partial<FaultConfig> = {}): FaultGenerator {
  const config = { ...DEFAULT_FAULT_CONFIG, ...overrides };
  validateConfig(config);
  let count = 0;

  return {
    step(tick) {
      const faults: Fault[] = [];
      for (const type of FAULT_TYPES) {
        if (!rng.chance(config.perTickChance[type])) continue;
        const location = drawLocation(rng, site, type, config);
        const severity = drawSeverity(rng, config.severityWeights[type]);
        count += 1;
        faults.push({ id: `F${String(count).padStart(4, "0")}`, type, severity, location, startTick: tick });
      }
      return faults;
    },
  };
}

export interface FaultRunOptions {
  seed: Seed;
  /** How many ticks to run. Faults start on ticks 1..ticks. */
  ticks: number;
  site?: Site;
  config?: Partial<FaultConfig>;
}

/** Runs the generator for `ticks` ticks and returns every fault, in order. */
export function runFaultLog({ seed, ticks, site = createSite(), config }: FaultRunOptions): Fault[] {
  const generator = createFaultGenerator(site, createRng(seed), config);
  const faults: Fault[] = [];
  for (let tick = 1; tick <= ticks; tick++) faults.push(...generator.step(tick));
  return faults;
}

/** "R07-P12" for one panel, "R07-P12..P20" for a span. */
export function formatLocation(location: FaultLocation): string {
  const first = panelId(location.row, location.colStart);
  if (location.colStart === location.colEnd) return first;
  return `${first}..${panelId(location.row, location.colEnd).split("-")[1]}`;
}

/** One log line. `clock` only supplies the tick length for the sim-time column. */
export function formatFault(fault: Fault, clock: Clock = createClock()): string {
  const time = formatSimTime(advance({ ...clock, tick: 0 }, fault.startTick));
  return [
    time,
    `tick=${String(fault.startTick).padStart(4, "0")}`,
    fault.id,
    fault.type.padEnd(13),
    `sev=${fault.severity}`,
    formatLocation(fault.location),
  ].join("  ");
}
