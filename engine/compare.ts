// Phase 4 comparison: the naive dispatcher and Arien's, on the same seeds, at several
// crew sizes. Both see exactly the same faults and the same repair-or-replace and
// can't-confirm outcomes (they come from their own seeded streams), so every difference
// in the numbers comes from the dispatch decisions alone.
//
// The result is plain data. scripts/compare.ts prints it. Deterministic.

import { arienDispatcher, naiveDispatcher } from "./dispatcher";
import { DEFAULT_FAULT_CONFIG, FAULT_TYPES, type FaultConfig } from "./faults";
import type { Dispatcher } from "./decisions";
import type { Severity } from "./faults";
import { mean, median, runWithMetrics, worst, type RunMetrics } from "./metrics";
import type { Seed } from "./rng";
import { createClock } from "./clock";
import { createDrone, createGroundRobot, createTechnician, type Worker } from "./workers";

export type DispatcherName = "naive" | "arien";
export const DISPATCHERS: Record<DispatcherName, Dispatcher> = { naive: naiveDispatcher, arien: arienDispatcher };

/**
 * "default": the drone has the normal battery.
 * "unlimited": an ablation. The drone's battery never limits it, for both dispatchers, to
 * show how much of the result comes from battery handling rather than from dispatching.
 */
export type BatteryMode = "default" | "unlimited";

export interface CompareOptions {
  seeds: readonly Seed[];
  /** Technician counts to compare, for example [1, 2, 4]. */
  techCounts: readonly number[];
  /** Sim days per run. */
  days: number;
  battery?: BatteryMode;
  /** Multiplies every fault rate. 1 = the demo rate (about 38 faults a day), 0.25 = a quarter of that. */
  faultScale?: number;
}

export const DEFAULT_COMPARE: CompareOptions = {
  seeds: [1, 2, 3, 4, 5],
  techCounts: [1, 2, 4],
  days: 3, // ASSUMPTION: three days is long enough to cover three shift changes and show backlog; not tuned further
  battery: "default",
  faultScale: 1,
};

function scaledFaults(scale: number): Partial<FaultConfig> | undefined {
  if (scale === 1) return undefined;
  const perTickChance = { ...DEFAULT_FAULT_CONFIG.perTickChance };
  for (const type of FAULT_TYPES) perTickChance[type] = Math.min(1, perTickChance[type] * scale);
  return { perTickChance };
}

/** One drone, one ground robot, and `techs` technicians who all work the same default shift. */
export function makeCrew(techs: number, battery: BatteryMode = "default"): Worker[] {
  if (!Number.isInteger(techs) || techs < 1) throw new Error(`Need at least one technician, got ${techs}`);
  const drone =
    battery === "unlimited"
      ? createDrone("D1", { battery: { capacityS: 1000 * 3600, rechargeS: 3600 } }) // ablation knob, not a real-world figure
      : createDrone("D1");
  return [drone, createGroundRobot("G1"), ...Array.from({ length: techs }, (_, i) => createTechnician(`T${i + 1}`))];
}

// ---------- metrics table ----------

export type Unit = "hours" | "minutes" | "count" | "percent";
export type Better = "lower" | "higher" | "none";

export interface MetricDef {
  key: string;
  label: string;
  group: string;
  unit: Unit;
  /** Which direction counts as better for the dispatcher. "none" = shown, never judged. */
  better: Better;
  /** The value for one run (one seed). null if it does not apply (for example no faults of that severity). */
  perRun(run: RunMetrics): number | null;
  /** The value shown in the table, across all runs. */
  pooled(runs: readonly RunMetrics[]): number | null;
}

const SEVERITIES: readonly Severity[] = [5, 4, 3, 2, 1];
const toHours = (ticks: number, run: RunMetrics) => (ticks * run.tickSeconds) / 3600;
const toMinutes = (ticks: number, run: RunMetrics) => (ticks * run.tickSeconds) / 60;
const waitsHours = (run: RunMetrics, severity: Severity) => run.faults.filter((f) => f.severity === severity).map((f) => toHours(f.waitTicks, run));

/** Mean of a per-run value across runs. */
const averaged = (perRun: (run: RunMetrics) => number | null) => (runs: readonly RunMetrics[]) =>
  mean(runs.flatMap((r) => perRun(r) ?? []));

function simple(key: string, label: string, group: string, unit: Unit, better: Better, perRun: (run: RunMetrics) => number | null): MetricDef {
  return { key, label, group, unit, better, perRun, pooled: averaged(perRun) };
}

const techsOf = (run: RunMetrics) => run.workers.filter((w) => w.type === "technician");
const workerOf = (run: RunMetrics, type: string) => run.workers.find((w) => w.type === type);

export const METRICS: readonly MetricDef[] = [
  // ---- throughput
  simple("faults", "Faults detected (same for both)", "Throughput (per run)", "count", "none", (r) => r.faults.length),
  simple("completed", "Faults fixed", "Throughput (per run)", "count", "higher", (r) => r.completed),
  simple("unfinished", "Faults still open at the end", "Throughput (per run)", "count", "lower", (r) => r.unfinished),
  simple("open_high", "  of which severity 4-5", "Throughput (per run)", "count", "lower", (r) => r.faults.filter((f) => f.doneTick === null && f.severity >= 4).length),
  simple("open_low", "  of which severity 1-2", "Throughput (per run)", "count", "lower", (r) => r.faults.filter((f) => f.doneTick === null && f.severity <= 2).length),

  // ---- wait until fixed, by severity
  ...SEVERITIES.flatMap((sev): MetricDef[] => [
    {
      key: `wait_median_${sev}`,
      label: `Severity ${sev}, median`,
      group: "Wait until fixed (hours)",
      unit: "hours",
      better: "lower",
      perRun: (r) => median(waitsHours(r, sev)),
      pooled: (runs) => median(runs.flatMap((r) => waitsHours(r, sev))),
    },
    {
      key: `wait_worst_${sev}`,
      label: `Severity ${sev}, worst`,
      group: "Wait until fixed (hours)",
      unit: "hours",
      better: "lower",
      perRun: (r) => worst(waitsHours(r, sev)),
      pooled: (runs) => worst(runs.flatMap((r) => waitsHours(r, sev))),
    },
  ]),

  // ---- first response
  {
    key: "response_median",
    label: "Median, all severities",
    group: "Time to first inspection (minutes)",
    unit: "minutes",
    better: "lower",
    perRun: (r) => median(r.faults.map((f) => toMinutes(f.responseTicks, r))),
    pooled: (runs) => median(runs.flatMap((r) => r.faults.map((f) => toMinutes(f.responseTicks, r)))),
  },
  {
    key: "response_worst",
    label: "Worst, all severities",
    group: "Time to first inspection (minutes)",
    unit: "minutes",
    better: "lower",
    perRun: (r) => worst(r.faults.map((f) => toMinutes(f.responseTicks, r))),
    pooled: (runs) => worst(runs.flatMap((r) => r.faults.map((f) => toMinutes(f.responseTicks, r)))),
  },

  // ---- failed handoffs
  simple("failed_total", "Total", "Failed handoffs (per run)", "count", "lower", (r) => r.failedHandoffs.total),
  simple("failed_timed_out", "Nobody accepted in time", "Failed handoffs (per run)", "count", "lower", (r) => r.failedHandoffs.timedOut),
  simple("failed_dropped_late", "Worker dropped out or was late", "Failed handoffs (per run)", "count", "lower", (r) => r.failedHandoffs.dropped + r.failedHandoffs.late),
  simple("failed_bounced", "Robot could not confirm", "Failed handoffs (per run)", "count", "none", (r) => r.failedHandoffs.bounced),

  // ---- wasted work
  simple("cut_off", "Jobs cut off mid-work (per run)", "Wasted work", "count", "lower", (r) => r.cutOffJobs),
  simple("lost_work", "Work thrown away (hours per run)", "Wasted work", "hours", "lower", (r) => toHours(r.lostWorkTicks, r)),

  // ---- workers
  simple("util_drone", "Drone busy (of its on-shift time)", "Workers", "percent", "none", (r) => workerOf(r, "drone")?.utilization ?? null),
  simple("util_robot", "Ground robot busy", "Workers", "percent", "none", (r) => workerOf(r, "ground_robot")?.utilization ?? null),
  simple("util_tech", "Technicians busy (average)", "Workers", "percent", "none", (r) => mean(techsOf(r).map((w) => w.utilization))),
  simple("drone_down", "Drone stranded (of all time)", "Workers", "percent", "lower", (r) => {
    const drone = workerOf(r, "drone");
    return drone ? drone.strandedTicks / r.ticks : null;
  }),
  simple("strandings", "Drone battery deaths (per run)", "Workers", "count", "lower", (r) => r.strandings),

  // ---- cost to the human
  simple("escalations", "Escalations to a person (per run)", "Human attention", "count", "lower", (r) => r.escalations),
];

// ---------- judging ----------

export type Verdict = "win" | "tie" | "lose" | "mixed" | "n/a";

export interface Judgement {
  verdict: Verdict;
  /** Seeds where Arien was clearly better, clearly worse, or about the same. */
  better: number;
  worse: number;
  ties: number;
  /** Seeds compared (those where both runs have a value). */
  seeds: number;
}

/** Differences smaller than this count as a tie. */
export function isTie(a: number, b: number, unit: Unit): boolean {
  const gap = Math.abs(a - b);
  const big = Math.max(Math.abs(a), Math.abs(b));
  switch (unit) {
    case "hours":
      return gap <= Math.max(5 / 60, 0.05 * big); // ASSUMPTION: within 5 minutes or 5% is a tie
    case "minutes":
      return gap <= Math.max(5, 0.05 * big); // ASSUMPTION
    case "count":
      return gap <= Math.max(1, 0.05 * big); // ASSUMPTION: within one item or 5%
    case "percent":
      return gap <= 0.02; // ASSUMPTION: within 2 percentage points
  }
}

/**
 * Compares Arien to the naive baseline seed by seed (the two runs on a seed face identical
 * faults). A win or loss needs at least 4 of every 5 seeds clearly one way. Otherwise it is
 * a tie if most seeds are ties, and mixed if not.
 */
export function judge(
  naive: ReadonlyArray<number | null>,
  arien: ReadonlyArray<number | null>,
  better: Better,
  unit: Unit,
): Judgement {
  if (naive.length !== arien.length) throw new Error("naive and arien need one value per seed");
  const result: Judgement = { verdict: "n/a", better: 0, worse: 0, ties: 0, seeds: 0 };
  naive.forEach((n, i) => {
    const a = arien[i];
    if (n === null || a === null) return;
    result.seeds += 1;
    if (isTie(n, a, unit)) result.ties += 1;
    else if ((a < n) === (better === "lower")) result.better += 1;
    else result.worse += 1;
  });
  if (better === "none" || result.seeds === 0) return result;
  const need = Math.ceil((4 * result.seeds) / 5);
  if (result.better >= need) result.verdict = "win";
  else if (result.worse >= need) result.verdict = "lose";
  else if (result.ties >= need) result.verdict = "tie";
  else result.verdict = "mixed";
  return result;
}

// ---------- running ----------

export interface ComparisonRow {
  metric: MetricDef;
  naive: number | null;
  arien: number | null;
  judgement: Judgement;
}

export interface CrewComparison {
  techs: number;
  naiveRuns: RunMetrics[];
  arienRuns: RunMetrics[];
  rows: ComparisonRow[];
}

export interface Comparison {
  options: CompareOptions;
  ticks: number;
  crews: CrewComparison[];
}

export function runComparison(input: Partial<CompareOptions> = {}): Comparison {
  const options: CompareOptions = { ...DEFAULT_COMPARE, ...input };
  if (!((options.faultScale ?? 1) > 0)) throw new Error(`faultScale must be > 0, got ${options.faultScale}`);
  const ticks = Math.round((options.days * 24 * 3600) / createClock().tickSeconds);

  const crews = options.techCounts.map((techs): CrewComparison => {
    const runAll = (name: DispatcherName) =>
      options.seeds.map(
        (seed) =>
          runWithMetrics({ seed, ticks, dispatcher: DISPATCHERS[name], crew: makeCrew(techs, options.battery), faultConfig: scaledFaults(options.faultScale ?? 1) })
            .metrics,
      );
    const naiveRuns = runAll("naive");
    const arienRuns = runAll("arien");
    const rows = METRICS.map((metric): ComparisonRow => ({
      metric,
      naive: metric.pooled(naiveRuns),
      arien: metric.pooled(arienRuns),
      judgement: judge(naiveRuns.map(metric.perRun), arienRuns.map(metric.perRun), metric.better, metric.unit),
    }));
    return { techs, naiveRuns, arienRuns, rows };
  });

  return { options, ticks, crews };
}
