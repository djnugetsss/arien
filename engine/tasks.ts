// Task lifecycle. Every fault becomes one task that walks this path:
//
//   detected -> inspect -> verify -> repair  -> done
//                                 \-> replace -> done
//
// State = the step the task is on. "detected" means nobody has picked it up yet.
// Within a step, `phase` says whether it is waiting for a worker, the worker is
// traveling there, or the worker is on site working.

import type { Fault, FaultType } from "./faults";
import type { Point, Skill } from "./workers";

export const TASK_STATES = ["detected", "inspect", "verify", "repair", "replace", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Legal moves. Anything else throws. */
export const NEXT_STATES: Record<TaskState, readonly TaskState[]> = {
  detected: ["inspect"],
  inspect: ["verify"],
  verify: ["repair", "replace"],
  repair: ["done"],
  replace: ["done"],
  done: [],
};

export type WorkStep = "inspect" | "verify" | "repair" | "replace";
export type OpenState = Exclude<TaskState, "done">;

/** Skill a worker needs to take the task in each state. */
export const STATE_SKILL: Record<OpenState, Skill> = {
  detected: "inspect",
  inspect: "inspect",
  verify: "verify",
  repair: "repair",
  replace: "replace",
};

export type TaskPhase = "waiting" | "traveling" | "working";

export interface Task {
  /** "T0007" for fault "F0007". */
  id: string;
  fault: Fault;
  state: TaskState;
  phase: TaskPhase;
  workerId: string | null;
  /** Work seconds left in the current step. Only meaningful while working. */
  workLeftS: number;
  /** Decided when the fault appears, revealed at verify. Keeps outcomes independent of dispatch. */
  needsReplace: boolean;
  /** Where workers go: the center of the fault's span. */
  target: Point;
  createdTick: number;
  doneTick: number | null;
}

export interface TaskConfig {
  /** On-site work seconds per step, per fault type. */
  workSeconds: Record<WorkStep, Record<FaultType, number>>;
  /** Chance that verification finds the part must be replaced, not repaired. */
  replaceChance: Record<FaultType, number>;
}

const MIN = 60;

export const DEFAULT_TASK_CONFIG: TaskConfig = {
  // ASSUMPTION: every duration below is a guess, to be checked by a practitioner after phase 2.
  workSeconds: {
    // ASSUMPTION: a close drone pass over the fault
    inspect: { hotspot: 5 * MIN, soiling: 5 * MIN, string_outage: 8 * MIN, tracker_stuck: 8 * MIN },
    // ASSUMPTION: up-close check with a thermal camera or meter
    verify: { hotspot: 10 * MIN, soiling: 5 * MIN, string_outage: 20 * MIN, tracker_stuck: 15 * MIN },
    // ASSUMPTION: cleaning, reseating connectors, resetting a tracker
    repair: { hotspot: 45 * MIN, soiling: 30 * MIN, string_outage: 60 * MIN, tracker_stuck: 90 * MIN },
    // ASSUMPTION: swapping a module or a tracker part, parts on hand
    replace: { hotspot: 120 * MIN, soiling: 120 * MIN, string_outage: 150 * MIN, tracker_stuck: 180 * MIN },
  },
  replaceChance: {
    hotspot: 0.4, // ASSUMPTION: hotspots often mean a damaged cell
    soiling: 0, // ASSUMPTION: dirt is always cleaned, never replaced
    string_outage: 0.15, // ASSUMPTION
    tracker_stuck: 0.1, // ASSUMPTION
  },
};

export function createTask(fault: Fault, needsReplace: boolean): Task {
  return {
    id: `T${fault.id.slice(1)}`,
    fault,
    state: "detected",
    phase: "waiting",
    workerId: null,
    workLeftS: 0,
    needsReplace,
    target: { x: fault.location.x, y: fault.location.y },
    createdTick: fault.startTick,
    doneTick: null,
  };
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return NEXT_STATES[from].includes(to);
}

/** Moves the task to `to`. Throws on an illegal move. */
export function transition(task: Task, to: TaskState): Task {
  if (!canTransition(task.state, to)) throw new Error(`${task.id}: illegal move ${task.state} -> ${to}`);
  return { ...task, state: to };
}

/** Where the task goes when the current step's work finishes. */
export function stateAfterWork(task: Task): TaskState {
  switch (task.state) {
    case "inspect":
      return "verify";
    case "verify":
      return task.needsReplace ? "replace" : "repair";
    case "repair":
    case "replace":
      return "done";
    default:
      throw new Error(`${task.id}: no work happens in state ${task.state}`);
  }
}

export function workSecondsFor(task: Task, config: TaskConfig = DEFAULT_TASK_CONFIG): number {
  if (task.state === "detected" || task.state === "done") throw new Error(`${task.id}: no work in state ${task.state}`);
  return config.workSeconds[task.state][task.fault.type];
}

export function skillFor(task: Task): Skill | null {
  return task.state === "done" ? null : STATE_SKILL[task.state];
}
