// Task lifecycle. Every fault becomes one task that walks this path:
//
//   detected -> inspect -> verify -> repair  -> done
//                                 \-> replace -> done
//                                 \-> done (false alarm, only after a person verifies)
//
// State = the step the task is on. "detected" means nobody has picked it up yet.
// Within a step, `phase` says whether it is waiting for a worker, the worker is
// traveling there, or the worker is on site working.
//
// A second kind of task, "recover", fetches a stranded worker. It is a single
// step: it starts in "repair" and ends in "done".

import type { Fault, FaultType, Severity } from "./faults";
import type { Point, Skill, Worker } from "./workers";

export const TASK_STATES = ["detected", "inspect", "verify", "repair", "replace", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Legal moves. Anything else throws. */
export const NEXT_STATES: Record<TaskState, readonly TaskState[]> = {
  detected: ["inspect"],
  inspect: ["verify"],
  verify: ["repair", "replace", "done"],
  repair: ["done"],
  replace: ["done"],
  done: [],
};

export type WorkStep = "inspect" | "verify" | "repair" | "replace";
export type OpenState = Exclude<TaskState, "done">;

/** Skill a worker needs to take a fault task in each state. */
export const STATE_SKILL: Record<OpenState, Skill> = {
  detected: "inspect",
  inspect: "inspect",
  verify: "verify",
  repair: "repair",
  replace: "replace",
};

export type TaskKind = "fault" | "recover";
export type TaskPhase = "waiting" | "traveling" | "working";
export type Resolution = "repaired" | "replaced" | "false_alarm" | "recovered" | "taken_over";

/** pickup: detection -> inspector. confirm: inspector -> verifier. fix: verifier -> repairer. */
export type HandoffKind = "pickup" | "confirm" | "fix" | "recover";

/** The current step's handoff: who needs to take it, by when, and how it is going. */
export interface Handoff {
  kind: HandoffKind;
  offeredTick: number;
  /** A worker must accept by this tick, or the handoff times out. */
  deadlineTick: number;
  workerId: string | null;
  acceptedTick: number | null;
  /** The accepting worker must arrive by this tick, or the handoff is late. */
  arriveByTick: number | null;
  completedTick: number | null;
  /** Dropped, late, or bounced so far on this step. Two means the retry failed too. */
  failCount: number;
  timedOut: boolean;
}

/**
 * What a task looked like the last time it was escalated. The dispatcher compares the
 * task now against this, so the same stuck situation is raised once, not again and again.
 */
export interface EscalatedState {
  /** The step the task was on. A new step is a new situation, not a change within one. */
  step: string;
  severity: Severity;
  /** How many failures the task had suffered by then. */
  disruptions: number;
  /** How bad the blocker was (see BLOCKER_RANK in decisions.ts). Only a worse one counts as new. */
  blockerRank: number;
  /** Tick the escalation was raised. Reminders count from here. */
  tick: number;
}

/** Set by the sim when something goes wrong. The dispatcher decides whether to escalate. */
export type TaskAlert = "timed_out" | "retry_failed" | "shift_cut";

export interface Task {
  /** "T0007" for fault "F0007". "R0001" for a recovery job. */
  id: string;
  kind: TaskKind;
  /** Short name for logs: the fault type, or "recover D1". */
  label: string;
  severity: Severity;
  /** null for recovery jobs. */
  fault: Fault | null;
  /** The stranded worker a recovery job fetches. */
  recoverWorkerId: string | null;
  state: TaskState;
  phase: TaskPhase;
  workerId: string | null;
  /** Work seconds left in the current step. Only meaningful while working. */
  workLeftS: number;
  // Outcomes are decided when the fault appears, so they never depend on the dispatcher.
  /** Revealed at verify: the part must be replaced, not repaired. */
  needsReplace: boolean;
  /** false = a robot's verify comes back "unconfirmed" and a person has to check. */
  robotCanConfirm: boolean;
  /** Only possible when the robot cannot confirm: a person finds nothing wrong. */
  falseAlarm: boolean;
  /** Workers who failed the current step on this task. They are not offered it again. */
  failedWorkerIds: readonly string[];
  /** A worker dropped the current step partway. Worth extra priority. */
  interrupted: boolean;
  resolution: Resolution | null;
  handoff: Handoff | null;
  alert: TaskAlert | null;
  /** The open escalation covering this task, if any. */
  escalationId: string | null;
  /** The last time this task was escalated, kept after the escalation is answered. */
  escalated: EscalatedState | null;
  /** Dropped, late, bounced, or cut-off handoffs on this task so far. Never goes down. */
  disruptions: number;
  /** A person said "wait until then". Reminders for this task start counting from here. */
  snoozeUntilTick: number;
  /** A person picked this worker. The sim assigns them as soon as they are free. */
  forcedWorkerId: string | null;
  /** Last hold reason logged, so the same hold is not logged every tick. */
  holdKey: string | null;
  /** Where workers go: the center of the fault's span, or the stranded worker. */
  target: Point;
  createdTick: number;
  doneTick: number | null;
}

export interface TaskConfig {
  /** On-site work seconds per step, per fault type. */
  workSeconds: Record<WorkStep, Record<FaultType, number>>;
  /** Chance that verification finds the part must be replaced, not repaired. */
  replaceChance: Record<FaultType, number>;
  /** Chance a robot's verify comes back "unconfirmed". */
  unconfirmedChance: number;
  /** Of the unconfirmed ones, the share a person finds to be a false alarm. */
  falseAlarmChance: number;
  /** On-site seconds to fetch a stranded worker. */
  recoverSeconds: number;
  /** Priority a recovery job is scored at. */
  recoverSeverity: Severity;
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
  unconfirmedChance: 0.15, // ASSUMPTION: the robot cannot confirm about 1 fault in 7
  falseAlarmChance: 0.3, // ASSUMPTION: 3 in 10 unconfirmed faults turn out to be nothing
  recoverSeconds: 10 * MIN, // ASSUMPTION: 10 minutes on site to pick up a dead drone
  recoverSeverity: 4, // ASSUMPTION: a stranded worker ranks like a serious fault
};

export interface FaultOutcomes {
  needsReplace: boolean;
  robotCanConfirm: boolean;
  falseAlarm: boolean;
}

function blankTask(): Omit<Task, "id" | "kind" | "label" | "severity" | "fault" | "target" | "createdTick" | "state"> {
  return {
    recoverWorkerId: null,
    phase: "waiting",
    workerId: null,
    workLeftS: 0,
    needsReplace: false,
    robotCanConfirm: true,
    falseAlarm: false,
    failedWorkerIds: [],
    interrupted: false,
    resolution: null,
    handoff: null,
    alert: null,
    escalationId: null,
    escalated: null,
    disruptions: 0,
    snoozeUntilTick: 0,
    forcedWorkerId: null,
    holdKey: null,
    doneTick: null,
  };
}

export function createTask(fault: Fault, outcomes: Partial<FaultOutcomes> = {}): Task {
  const robotCanConfirm = outcomes.robotCanConfirm ?? true;
  return {
    ...blankTask(),
    id: `T${fault.id.slice(1)}`,
    kind: "fault",
    label: fault.type,
    severity: fault.severity,
    fault,
    state: "detected",
    needsReplace: outcomes.needsReplace ?? false,
    robotCanConfirm,
    falseAlarm: !robotCanConfirm && (outcomes.falseAlarm ?? false),
    target: { x: fault.location.x, y: fault.location.y },
    createdTick: fault.startTick,
  };
}

/** A job to fetch a stranded worker from where it stopped. */
export function createRecoverTask(seq: number, stranded: Worker, tick: number, config: TaskConfig = DEFAULT_TASK_CONFIG): Task {
  return {
    ...blankTask(),
    id: `R${String(seq).padStart(4, "0")}`,
    kind: "recover",
    label: `recover ${stranded.id}`,
    severity: config.recoverSeverity,
    fault: null,
    recoverWorkerId: stranded.id,
    state: "repair",
    target: { ...stranded.position },
    createdTick: tick,
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

/** Where a fault task goes when the current step's work finishes normally. */
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

/** The step a worker would do if assigned now. A detected task's next step is inspect. */
export function stepOf(task: Task): WorkStep | "recover" | null {
  if (task.state === "done") return null;
  if (task.kind === "recover") return "recover";
  return task.state === "detected" ? "inspect" : task.state;
}

/** On-site seconds for the step a worker would do if assigned now. */
export function workSecondsFor(task: Task, config: TaskConfig = DEFAULT_TASK_CONFIG): number {
  const step = stepOf(task);
  if (step === null) throw new Error(`${task.id}: no work in state ${task.state}`);
  if (step === "recover" || !task.fault) return config.recoverSeconds;
  return config.workSeconds[step][task.fault.type];
}

export function skillFor(task: Task): Skill | null {
  if (task.state === "done") return null;
  return task.kind === "recover" ? "recover" : STATE_SKILL[task.state];
}

export function handoffKindFor(task: Task): HandoffKind {
  if (task.kind === "recover") return "recover";
  if (task.state === "verify") return "confirm";
  return task.state === "repair" || task.state === "replace" ? "fix" : "pickup";
}

/** Waiting for a worker, and not reserved for one a person picked. */
export function isWaiting(task: Task): boolean {
  return task.state !== "done" && task.workerId === null;
}
