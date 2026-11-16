// Shared types for the coordination layer: what a dispatcher is given, what it
// can decide, the "why" record kept for every decision, and escalations.

import { formatSimTime, type Clock } from "./clock";
import type { FaultType, Severity } from "./faults";
import type { Task, TaskConfig } from "./tasks";
import type { Worker } from "./workers";

// ---------- config ----------

export interface CoordinationConfig {
  /** Seconds a handoff may wait for a worker to accept it, by severity. */
  acceptWithinS: Record<Severity, number>;
  /** Extra seconds allowed on top of travel time before an arrival counts as late. */
  arrivalGraceS: number;
  /** Seconds before the stand-in human approves the suggested action in headless runs. */
  autoHumanDelayS: number;
  /** Score points per severity level. */
  severityPoints: number;
  /** Minutes of waiting worth one score point, and the most points waiting can add. */
  minutesPerWaitPoint: number;
  waitCap: number;
  typeBonus: Record<FaultType, number>;
  interruptedBonus: number;
  /** Tasks within this many points of each other count as a near-tie: the closer one wins. */
  nearTiePoints: number;
  /** Share of battery kept in reserve when planning a trip. */
  batteryReserve: number;
  /** A repair cut off by shift end escalates at this severity or above. */
  shiftCutEscalateSeverity: Severity;
  /**
   * A task that stays stuck with nothing changing is raised again this many seconds after
   * it was last raised (or after a snooze ended). The only reason to raise it again.
   */
  reminderAfterS: number;
}

const MIN = 60;

export const DEFAULT_COORDINATION_CONFIG: CoordinationConfig = {
  // ASSUMPTION: response-time targets are guesses, not from any real service contract.
  acceptWithinS: { 5: 15 * MIN, 4: 30 * MIN, 3: 60 * MIN, 2: 120 * MIN, 1: 240 * MIN },
  arrivalGraceS: 5 * MIN, // ASSUMPTION
  autoHumanDelayS: 10 * MIN, // ASSUMPTION: a supervisor answers within 10 minutes
  severityPoints: 20, // ASSUMPTION: one severity level outweighs two hours of waiting
  minutesPerWaitPoint: 6, // ASSUMPTION: 10 points per hour waited
  waitCap: 60, // ASSUMPTION: so an old sev-1 never beats a fresh sev-5
  typeBonus: { tracker_stuck: 15, string_outage: 10, hotspot: 5, soiling: 0 }, // ASSUMPTION: more panels down, more points
  interruptedBonus: 20, // ASSUMPTION
  nearTiePoints: 10, // ASSUMPTION
  batteryReserve: 0.2, // ASSUMPTION: keep 20% of the battery in reserve
  shiftCutEscalateSeverity: 4, // ASSUMPTION
  reminderAfterS: 8 * 3600, // ASSUMPTION: remind once per 8-hour shift if a stuck task is still unchanged
};

// ---------- rules ----------

/** Every decision names the rule that made it. This is the full list. */
export const RULES = [
  // assign
  "ASSIGN_SPECIALIST_NEAREST", // Arien: best-ranked worker for the top-scored task
  "ASSIGN_NEAR_TIE_CLOSER", // Arien: two tasks within a few points, worker takes the closer one
  "ASSIGN_FIRST_FREE", // naive baseline
  // hold: nobody can take the task yet
  "HOLD_BUSY",
  "HOLD_BATTERY",
  "HOLD_SHIFT_TOO_SHORT",
  "HOLD_TECH_GUARD",
  "HOLD_OFF_SHIFT",
  "HOLD_STRANDED",
  "HOLD_NO_CAPABLE_WORKER",
  // things the sim does when a worker drops out or fails
  "RELEASE_BATTERY_DIED",
  "RELEASE_SHIFT_ENDED",
  "RETRY_AFTER_DROP",
  "RETRY_AFTER_LATE",
  "RETRY_AFTER_BOUNCE",
  "HANDOFF_RETRY_FAILED",
  "HANDOFF_TIMED_OUT",
  // escalate
  "ESCALATE_STRANDED",
  "ESCALATE_HANDOFF_TIMEOUT",
  "ESCALATE_NO_WORKER_ON_SHIFT",
  "ESCALATE_RETRY_FAILED",
  "ESCALATE_NO_SKILL_IN_CREW",
  "ESCALATE_NOBODY_LEFT", // everyone with the skill has already failed this step on this task
  "ESCALATE_SHIFT_CUT_REPAIR",
  "ESCALATE_SITUATION_CHANGED", // already raised, then severity, failures, or the blocker got worse
  "REMIND_STILL_WAITING", // already raised, nothing changed, a long time has passed
  "NOTICE_SEV5",
  // human
  "HUMAN_APPROVE",
  "HUMAN_WAIT",
  "OVERRIDE_REASSIGN",
  "OVERRIDE_TAKE_OVER",
] as const;
export type Rule = (typeof RULES)[number];

// ---------- blockers ----------

/**
 * Why a waiting task cannot start, from least to most serious. Used to decide whether a
 * task that was already raised is stuck in a new way. Only a worse blocker counts as new:
 * a shift starting (off_shift -> capacity) is good news and raises nothing.
 */
export type Blocker = "capacity" | "off_shift" | "nobody_left" | "no_skill";

export const BLOCKER_RANK: Record<Blocker, number> = {
  capacity: 0, // workers who could do it exist and are on shift, but are busy or low on battery or shift time
  off_shift: 1, // every worker who could do it is off shift
  nobody_left: 2, // every worker with the skill has already failed this step on this task
  no_skill: 3, // nobody in the crew has the skill at all
};

// ---------- why log ----------

export interface Score {
  total: number;
  severity: number;
  wait: number;
  type: number;
  interrupted: number;
}

export type RejectKind = "failed" | "stranded" | "busy" | "off_shift" | "battery" | "shift_short" | "guard";

/** One worker considered for a task. Only workers with the skill are listed. */
export interface Candidate {
  workerId: string;
  ok: boolean;
  /** Seconds to reach the task. */
  travelS: number;
  /** First check the worker failed, with the reason in words. */
  rejectKind?: RejectKind;
  reject?: string;
}

export type DecisionKind = "assign" | "hold" | "handoff" | "retry" | "release" | "escalate" | "resolve" | "override";

/** One entry in the why log. Every decision gets one. */
export interface WhyRecord {
  tick: number;
  kind: DecisionKind;
  rule: Rule;
  taskId: string;
  workerId?: string;
  score?: Score;
  considered?: Candidate[];
  /** The reason, in one or two plain sentences. Never empty. */
  why: string;
}

// ---------- dispatcher contract ----------

export interface DispatchContext {
  clock: Clock;
  /** Creation order. */
  tasks: readonly Task[];
  /** Crew order. */
  workers: readonly Worker[];
  /** Ids of workers already on a task. */
  busy: ReadonlySet<string>;
  coord: CoordinationConfig;
  taskConfig: TaskConfig;
}

export type SuggestedAction =
  | { action: "wait"; untilTick: number; label: string }
  | { action: "ack"; label: string };

export type EscalationLevel = "urgent" | "needs_decision" | "notice";

export type DispatchDecision =
  | { kind: "assign"; rule: Rule; taskId: string; workerId: string; why: string; score?: Score; considered?: Candidate[] }
  | {
      kind: "hold";
      rule: Rule;
      taskId: string;
      why: string;
      /** Stable id for this reason. The sim logs a hold only when the key changes. */
      key: string;
      score?: Score;
      considered?: Candidate[];
    }
  | {
      kind: "escalate";
      rule: Rule;
      level: EscalationLevel;
      taskIds: string[];
      headline: string;
      why: string;
      suggested: SuggestedAction;
      /** How the task is blocked right now. Stored with the escalation so a worse one counts as new. */
      blocker: Blocker;
      /** Tasks stuck for the same reason share one escalation. */
      digestKey?: string;
    };

/** A dispatcher is a pure function: same context in, same decisions out. No randomness. */
export type Dispatcher = (ctx: DispatchContext) => DispatchDecision[];

// ---------- escalations ----------

export type HumanActionKind = "approve" | "reassign" | "take_over" | "wait";

export interface EscalationOption {
  action: HumanActionKind;
  label: string;
}

/** What the human sees in the inbox. All structured, no LLM needed. */
export interface Escalation {
  id: string;
  openedTick: number;
  level: EscalationLevel;
  rule: Rule;
  headline: string;
  /** The trigger, in words. */
  why: string;
  taskIds: string[];
  workerId: string | null;
  digestKey: string | null;
  /** Recent why-log lines for these tasks: what was already tried. */
  tried: string[];
  suggested: SuggestedAction;
  options: EscalationOption[];
  /** If nobody responds by this tick, the suggested action is applied. */
  defaultAtTick: number;
  status: "open" | "resolved";
  resolvedTick: number | null;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface HumanAction {
  escalationId: string;
  action: HumanActionKind;
  /** Who acted. "auto-human" for the headless stand-in. */
  by?: string;
  /** For reassign. */
  workerId?: string;
  /** For wait. */
  untilTick?: number;
}

// ---------- printing ----------

export function formatScore(score: Score): string {
  const parts = [`sev ${score.severity}`, `wait ${score.wait}`, `type ${score.type}`];
  if (score.interrupted) parts.push(`interrupted ${score.interrupted}`);
  return `score ${score.total} (${parts.join(" + ")})`;
}

/** Two lines: what was decided, then why. */
export function formatDecision(record: WhyRecord, clock: Clock): string {
  const time = formatSimTime({ ...clock, tick: record.tick });
  const head = [time, `tick=${String(record.tick).padStart(5, "0")}`, record.taskId, record.kind.padEnd(8), record.workerId ?? ""];
  return `${head.join("  ").trimEnd()}\n    why: ${record.why}  [${record.rule}]`;
}
