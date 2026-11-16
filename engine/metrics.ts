// Phase 4 metrics. Measures a finished (or running) sim without changing it.
//
//   Fault wait time      detection -> fixed. A fault still open at the end of the run is
//                        charged the time it has waited so far, so a dispatcher that never
//                        finishes things is not flattered. Both dispatchers see the same
//                        faults and the same end tick, so the cut-off is equally fair.
//   Time to first        detection -> a worker accepts the first inspection handoff.
//   Failed handoffs      timed out, dropped, late, bounced (counted from the event log).
//   Utilization          ticks with a task assigned / ticks on shift, per worker.
//   Tasks completed      fault tasks that reached "done" (repaired, replaced, false alarm,
//                        or taken over by a person).
//
// Pure TypeScript. No randomness, no wall clock. Same sim in, same numbers out.

import type { Severity } from "./faults";
import { createSim, stepSim, type Sim, type SimOptions } from "./sim";
import type { Resolution } from "./tasks";
import { isOnShift } from "./workers";

// ---------- small stats ----------

/** Middle value, or the mean of the two middle values. null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Largest value, or null for an empty list. */
export function worst(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => (b > a ? b : a));
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------- shapes ----------

export interface FaultRecord {
  taskId: string;
  severity: Severity;
  createdTick: number;
  doneTick: number | null;
  resolution: Resolution | null;
  /** Ticks from detection to fixed, or to the end of the run if still open. */
  waitTicks: number;
  /** Ticks from detection to the first accepted inspection handoff, or to the end if none. */
  responseTicks: number;
  /** false if nobody ever accepted the first handoff (responseTicks is then a lower bound). */
  responded: boolean;
}

export interface WorkerMetrics {
  id: string;
  type: string;
  /** Ticks the worker was on shift (every tick, for workers with no shift). */
  onShiftTicks: number;
  /** Ticks the worker had a task assigned: traveling to it or working on it. */
  busyTicks: number;
  /** Ticks the worker sat stranded with a dead battery. */
  strandedTicks: number;
  /** busyTicks / onShiftTicks, 0 to 1. */
  utilization: number;
}

export interface FailedHandoffs {
  total: number;
  /** Nobody accepted before the deadline. */
  timedOut: number;
  /** The worker dropped out (battery died or shift ended) on the way. */
  dropped: number;
  /** The worker did not arrive in time. */
  late: number;
  /** The worker arrived but could not do the step (robot could not confirm). */
  bounced: number;
}

export interface RunMetrics {
  /** Ticks the run covered. */
  ticks: number;
  tickSeconds: number;
  faults: FaultRecord[];
  completed: number;
  /** Faults detected but not done by the end of the run. */
  unfinished: number;
  failedHandoffs: FailedHandoffs;
  workers: WorkerMetrics[];
  /** Jobs a worker was working on when they were pulled off (battery died or shift ended). */
  cutOffJobs: number;
  /** Ticks of on-site work thrown away by those cut-off jobs. Progress on a step is lost. */
  lostWorkTicks: number;
  /** Times a worker ran out of battery away from home. */
  strandings: number;
  /** Escalations that needed a person (urgent or needs_decision). Notices do not count. */
  escalations: number;
}

// ---------- recorder ----------

export interface Recorder {
  /** Call once after every stepSim. */
  record(): void;
  /** Builds the metrics for everything recorded so far. */
  finish(): RunMetrics;
}

export function createRecorder(sim: Sim): Recorder {
  const tally = sim.workers.map((w) => ({ id: w.id, type: w.type, onShiftTicks: 0, busyTicks: 0, strandedTicks: 0 }));

  return {
    record() {
      const busy = new Set<string>();
      for (const task of sim.tasks) if (task.workerId !== null) busy.add(task.workerId);
      sim.workers.forEach((worker, i) => {
        const t = tally[i];
        if (isOnShift(worker.shift, sim.clock)) t.onShiftTicks += 1;
        if (busy.has(worker.id)) t.busyTicks += 1;
        if (worker.status === "stranded") t.strandedTicks += 1;
      });
    },

    finish() {
      const endTick = sim.clock.tick;

      const firstAccepted = new Map<string, number>();
      const workStarted = new Map<string, number>(); // task -> tick the current on-site work began
      let cutOffJobs = 0;
      let lostWorkTicks = 0;
      const failed: FailedHandoffs = { total: 0, timedOut: 0, dropped: 0, late: 0, bounced: 0 };
      let strandings = 0;
      for (const e of sim.events) {
        if (e.kind === "handoff_accepted" && e.handoff === "pickup" && !firstAccepted.has(e.taskId)) firstAccepted.set(e.taskId, e.tick);
        if (e.kind === "stranded") strandings += 1;
        if (e.kind === "handoff_completed") workStarted.set(e.taskId, e.tick);
        else if (e.kind === "state" || e.kind === "handoff_accepted") workStarted.delete(e.taskId);
        else if (e.kind === "released") {
          const started = workStarted.get(e.taskId);
          if (started !== undefined) {
            cutOffJobs += 1;
            lostWorkTicks += e.tick - started;
            workStarted.delete(e.taskId);
          }
        }
        if (e.kind === "handoff_failed") {
          failed.total += 1;
          if (e.reason === "timed_out") failed.timedOut += 1;
          else if (e.reason === "dropped") failed.dropped += 1;
          else if (e.reason === "late") failed.late += 1;
          else failed.bounced += 1;
        }
      }

      const faults: FaultRecord[] = sim.tasks
        .filter((t) => t.kind === "fault")
        .map((t) => {
          const accepted = firstAccepted.get(t.id);
          return {
            taskId: t.id,
            severity: t.severity,
            createdTick: t.createdTick,
            doneTick: t.doneTick,
            resolution: t.resolution,
            waitTicks: (t.doneTick ?? endTick) - t.createdTick,
            responseTicks: (accepted ?? endTick) - t.createdTick,
            responded: accepted !== undefined,
          };
        });
      const completed = faults.filter((f) => f.doneTick !== null).length;

      return {
        ticks: endTick,
        tickSeconds: sim.clock.tickSeconds,
        faults,
        completed,
        unfinished: faults.length - completed,
        failedHandoffs: failed,
        cutOffJobs,
        lostWorkTicks,
        workers: tally.map((t) => ({ ...t, utilization: t.onShiftTicks === 0 ? 0 : t.busyTicks / t.onShiftTicks })),
        strandings,
        escalations: sim.escalations.filter((e) => e.level !== "notice").length,
      };
    },
  };
}

/** Runs a sim for `ticks` ticks, recording every tick. */
export function runWithMetrics(options: SimOptions & { ticks: number }): { sim: Sim; metrics: RunMetrics } {
  const sim = createSim(options);
  const recorder = createRecorder(sim);
  for (let i = 0; i < options.ticks; i++) {
    stepSim(sim);
    recorder.record();
  }
  return { sim, metrics: recorder.finish() };
}
