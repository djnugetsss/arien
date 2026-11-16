// The two dispatchers. Both are rule-based pure functions: no randomness, no clock
// reads, no LLM. See docs/dispatcher-spec.md.
//
//   arienDispatcher: scores tasks, filters and ranks workers, logs holds, escalates.
//   naiveDispatcher: oldest task first, first free worker. The comparison baseline.

import { formatTimeOfDay, type Clock } from "./clock";
import {
  BLOCKER_RANK,
  formatScore,
  type Blocker,
  type Candidate,
  type DispatchContext,
  type DispatchDecision,
  type Dispatcher,
  type RejectKind,
  type Rule,
  type Score,
  type CoordinationConfig,
  type SuggestedAction,
} from "./decisions";
import { formatLocation } from "./faults";
import { isWaiting, skillFor, stepOf, workSecondsFor, type Task } from "./tasks";
import {
  hasSkill,
  isAvailable,
  isOnShift,
  secondsUntilShiftStart,
  shiftSecondsLeft,
  travelSeconds,
  type Worker,
} from "./workers";

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

// ---------- 1. task scoring ----------

export function scoreTask(task: Task, clock: Clock, coord: CoordinationConfig): Score {
  const ageMinutes = ((clock.tick - task.createdTick) * clock.tickSeconds) / 60;
  const severity = coord.severityPoints * task.severity;
  const wait = Math.min(coord.waitCap, Math.floor(ageMinutes / coord.minutesPerWaitPoint));
  const type = task.fault ? coord.typeBonus[task.fault.type] : 0;
  const interrupted = task.interrupted ? coord.interruptedBonus : 0;
  return { total: severity + wait + type + interrupted, severity, wait, type, interrupted };
}

interface Scored {
  task: Task;
  score: Score;
}

/** Highest score first. Ties: higher severity, then older, then lower id. */
function byPriority(a: Scored, b: Scored): number {
  return (
    b.score.total - a.score.total ||
    b.task.severity - a.task.severity ||
    a.task.createdTick - b.task.createdTick ||
    (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0)
  );
}

// ---------- 2. worker choice ----------

interface Evaluated extends Candidate {
  worker: Worker;
  crewIndex: number;
  /** Seconds of battery or shift left over after the job. Infinity when neither limits the worker. */
  slackS: number;
}

interface Round {
  ctx: DispatchContext;
  /** Worker id -> task id, including workers assigned earlier this tick. */
  busyOn: Map<string, string>;
  /** Tasks still waiting for a worker this tick. */
  remaining: Scored[];
}

/** Runs the filter checks in order. The first one a worker fails is the reject reason. */
function evaluate(worker: Worker, crewIndex: number, task: Task, round: Round): Evaluated | null {
  const { ctx } = round;
  const skill = skillFor(task);
  if (!skill || !hasSkill(worker, skill)) return null; // not capable, not listed

  const travelS = travelSeconds(worker, task.target);
  const workS = workSecondsFor(task, ctx.taskConfig);
  const base = { worker, crewIndex, workerId: worker.id, travelS, slackS: Infinity };
  const reject = (rejectKind: RejectKind, text: string): Evaluated => ({ ...base, ok: false, rejectKind, reject: text });

  if (task.failedWorkerIds.includes(worker.id)) return reject("failed", "already failed this step");
  if (worker.status === "stranded") return reject("stranded", "stranded");
  const busyOn = round.busyOn.get(worker.id);
  if (busyOn) return reject("busy", `busy on ${busyOn}`);
  if (!isOnShift(worker.shift, ctx.clock)) {
    const startTick = ctx.clock.tick + Math.ceil(secondsUntilShiftStart(worker.shift, ctx.clock) / ctx.clock.tickSeconds);
    return reject("off_shift", `off shift until ${formatTimeOfDay(ctx.clock, startTick)}`);
  }

  let slackS = Infinity;
  if (worker.battery) {
    const tripS = travelS + workS + travelSeconds(worker, worker.home, task.target);
    const needS = tripS + ctx.coord.batteryReserve * worker.battery.capacityS;
    if (worker.battery.chargeS < needS) {
      const chargeMin = minutes(((needS - worker.battery.chargeS) * worker.battery.rechargeS) / worker.battery.capacityS);
      return reject("battery", `needs about ${chargeMin} more min of charge (trip ${minutes(tripS)} min plus reserve)`);
    }
    slackS = Math.min(slackS, worker.battery.chargeS - needS);
  }
  if (worker.shift) {
    const leftS = shiftSecondsLeft(worker.shift, ctx.clock);
    if (leftS < travelS + workS) {
      return reject("shift_short", `shift ends in ${minutes(leftS)} min, job needs ${minutes(travelS + workS)} min`);
    }
    slackS = Math.min(slackS, leftS - travelS - workS);
  }

  // Technician guard: a repair-capable worker only verifies when no repair job is waiting
  // that they could take right now. The guard exists so the robot verifies first. It does
  // not apply when no verify-only worker is left for this task (for example the robot
  // already failed it), or the task could never be verified at all.
  const canFix = (w: Worker) => hasSkill(w, "repair") || hasSkill(w, "replace");
  if (skill === "verify" && canFix(worker)) {
    const specialistLeft = ctx.workers.some((w) => hasSkill(w, "verify") && !canFix(w) && !task.failedWorkerIds.includes(w.id));
    const waitingFix = specialistLeft
      ? round.remaining.find(({ task: other }) => {
          const otherSkill = skillFor(other);
          if (other.id === task.id || (otherSkill !== "repair" && otherSkill !== "replace")) return false;
          if (!hasSkill(worker, otherSkill) || other.failedWorkerIds.includes(worker.id)) return false;
          const needS = travelSeconds(worker, other.target) + workSecondsFor(other, ctx.taskConfig);
          return shiftSecondsLeft(worker.shift, ctx.clock) >= needS;
        })
      : undefined;
    if (waitingFix) return reject("guard", `held for ${stepOf(waitingFix.task)} job ${waitingFix.task.id}`);
  }

  return { ...base, ok: true, slackS };
}

/** Specialist first, then earliest arrival, then most slack, then crew order. */
function byRank(a: Evaluated, b: Evaluated): number {
  return (
    a.worker.skills.length - b.worker.skills.length ||
    a.travelS - b.travelS ||
    (a.slackS === b.slackS ? 0 : b.slackS > a.slackS ? 1 : -1) ||
    a.crewIndex - b.crewIndex
  );
}

function candidatesFor(task: Task, round: Round): { all: Evaluated[]; ok: Evaluated[] } {
  const all = round.ctx.workers.flatMap((w, i) => evaluate(w, i, task, round) ?? []);
  return { all, ok: all.filter((c) => c.ok).sort(byRank) };
}

const strip = (c: Evaluated): Candidate => ({
  workerId: c.workerId,
  ok: c.ok,
  travelS: Math.round(c.travelS),
  ...(c.ok ? {} : { rejectKind: c.rejectKind, reject: c.reject }),
});

/** Why this worker beat the runner-up, in a few words. */
function chosenBecause(ok: Evaluated[], step: string): string {
  const [best, next] = ok;
  const away = `${Math.round(best.travelS)} s away`;
  if (!next) return `${best.workerId} chosen: only free worker who can ${step}, ${away}`;
  if (best.worker.skills.length !== next.worker.skills.length) {
    return `${best.workerId} chosen: specialist first (${best.worker.skills.length} skills vs ${next.workerId}'s ${next.worker.skills.length}), ${away}`;
  }
  if (best.travelS !== next.travelS) return `${best.workerId} chosen: closest, ${away} vs ${next.workerId} at ${Math.round(next.travelS)} s`;
  if (best.slackS !== next.slackS) return `${best.workerId} chosen: most battery or shift time to spare, ${away}`;
  return `${best.workerId} chosen: first in crew order, ${away}`;
}

function skippedText(all: Evaluated[]): string {
  const skipped = all.filter((c) => !c.ok);
  return skipped.length ? ` Skipped ${skipped.map((c) => `${c.workerId}: ${c.reject}`).join("; ")}.` : "";
}

/** Which hold rule fits. A worker who is merely busy is the most hopeful case, so it wins. */
const HOLD_RULES: Array<[RejectKind, Rule]> = [
  ["busy", "HOLD_BUSY"],
  ["battery", "HOLD_BATTERY"],
  ["shift_short", "HOLD_SHIFT_TOO_SHORT"],
  ["guard", "HOLD_TECH_GUARD"],
  ["off_shift", "HOLD_OFF_SHIFT"],
  ["stranded", "HOLD_STRANDED"],
];

function holdDecision({ task, score }: Scored, all: Evaluated[]): DispatchDecision {
  const step = stepOf(task);
  const rule = HOLD_RULES.find(([kind]) => all.some((c) => c.rejectKind === kind))?.[1] ?? "HOLD_NO_CAPABLE_WORKER";
  const reasons = all.length
    ? all.map((c) => `${c.workerId}: ${c.reject}`).join("; ")
    : `nobody in the crew can ${step}`;
  return {
    kind: "hold",
    rule,
    taskId: task.id,
    key: `${step}|${rule}|${all.map((c) => `${c.workerId}:${c.rejectKind}`).join(",")}`,
    why: `${formatScore(score)}. Nobody can ${step} yet. ${reasons}.`,
    score,
    considered: all.map(strip),
  };
}

// ---------- 5. escalation triggers ----------
//
// One escalation per stuck task. A task that was already raised is raised again only when:
//   - its severity changed,
//   - it suffered another failure (dropped, late, bounced, or cut off),
//   - its blocker got worse (for example every worker who could take it went off shift), or
//   - a long time (reminderAfterS) passed with nothing changing.
// A snooze ending is not on that list, and neither is a handoff deadline: a handoff times
// out once, and the sim never resets that clock.

function describe(task: Task): string {
  const where = task.fault ? ` at ${formatLocation(task.fault.location)}` : "";
  return task.kind === "fault" ? `Sev ${task.severity} ${task.label}${where}` : `Job to ${task.label}`;
}

/** How the task is blocked right now. */
export function blockerOf(task: Task, ctx: DispatchContext): Blocker {
  const skill = skillFor(task);
  if (!skill || !ctx.workers.some((w) => hasSkill(w, skill))) return "no_skill";
  const capable = ctx.workers.filter((w) => hasSkill(w, skill) && !task.failedWorkerIds.includes(w.id));
  return capable.length > 0 && capable.every((w) => !isOnShift(w.shift, ctx.clock)) ? "off_shift" : "capacity";
}

interface Raise {
  rule: Rule;
  headline: (n: number) => string;
  why: string;
  suggested: SuggestedAction;
  /** Tasks stuck for the same reason at the same time share one escalation. */
  digestKey?: string;
}

function escalations(ctx: DispatchContext): DispatchDecision[] {
  const { clock, coord } = ctx;
  const tick = clock.tick;
  const out: DispatchDecision[] = [];
  const digests = new Map<string, Extract<DispatchDecision, { kind: "escalate" }>>();
  const ticksFor = (seconds: number) => Math.ceil(seconds / clock.tickSeconds);
  const reminderHours = Math.round(coord.reminderAfterS / 3600);
  const keepQueued: SuggestedAction = { action: "ack", label: `Keep it queued. You'll be reminded in ${reminderHours} h if nothing changes` };

  for (const task of ctx.tasks) {
    // A new severity-5 fault: tell the human, nothing to decide.
    if (task.kind === "fault" && task.severity === 5 && task.createdTick === tick) {
      out.push({
        kind: "escalate",
        rule: "NOTICE_SEV5",
        level: "notice",
        taskIds: [task.id],
        headline: `${describe(task)} just appeared`,
        why: "New severity-5 fault. For your information, no action needed.",
        suggested: { action: "ack", label: "Nothing to do" },
        blocker: "capacity",
      });
    }

    // One open escalation per task: while it sits in the inbox there is nothing to add.
    if (!isWaiting(task) || task.escalationId !== null) continue;

    const step = stepOf(task)!;
    const skill = skillFor(task)!;
    const blocker = blockerOf(task, ctx);
    const rank = BLOCKER_RANK[blocker];
    const waitedMin = minutes((tick - task.createdTick) * clock.tickSeconds);

    // What was raised last time for this step, and what has changed since.
    const prev = task.escalated && task.escalated.step === step ? task.escalated : null;
    const changes: string[] = [];
    if (prev) {
      if (task.severity !== prev.severity) changes.push(`severity changed from ${prev.severity} to ${task.severity}`);
      if (task.disruptions > prev.disruptions) {
        const n = task.disruptions - prev.disruptions;
        changes.push(`${n} more failed handoff${n === 1 ? "" : "s"} on this step`);
      }
      if (rank > prev.blockerRank) {
        changes.push(blocker === "off_shift" ? `every worker who can ${step} is now off shift` : `nobody in the crew can ${step}`);
      }
    }
    const isNew = prev === null || changes.length > 0;

    // Suggested answers.
    const capable = ctx.workers.filter((w) => hasSkill(w, skill) && !task.failedWorkerIds.includes(w.id));
    const nextShiftTick = tick + Math.min(...capable.map((w) => ticksFor(secondsUntilShiftStart(w.shift, clock))), Infinity);
    const firstBack = capable.reduce<Worker | null>(
      (best, w) => (!best || secondsUntilShiftStart(w.shift, clock) < secondsUntilShiftStart(best.shift, clock) ? w : best),
      null,
    );
    const waitForShift: SuggestedAction = {
      action: "wait",
      untilTick: nextShiftTick,
      label: `Wait for ${firstBack?.id}, shift starts ${formatTimeOfDay(clock, nextShiftTick)}`,
    };
    const offShift = blocker === "off_shift";

    const fromAlert = (): Raise | null => {
      switch (task.alert) {
        case "retry_failed":
          return {
            rule: "ESCALATE_RETRY_FAILED",
            headline: () => `${describe(task)}: handoff for ${step} failed twice`,
            why: `The first worker and the retry both failed to take over ${step}.`,
            suggested: offShift ? waitForShift : keepQueued,
          };
        case "timed_out":
          return offShift
            ? {
                rule: "ESCALATE_NO_WORKER_ON_SHIFT",
                digestKey: `no_shift:${skill}`,
                headline: (n) => (n === 1 ? `${describe(task)} has waited ${waitedMin} min for ${step}, nobody is on shift` : `${n} tasks are past their deadline waiting for ${skill}, nobody is on shift`),
                why: `Past the response deadline for ${step}, and every worker who can ${step} is off shift.`,
                suggested: waitForShift,
              }
            : {
                rule: "ESCALATE_HANDOFF_TIMEOUT",
                digestKey: `timeout:${skill}`,
                headline: (n) => (n === 1 ? `${describe(task)} has waited ${waitedMin} min for ${step}` : `${n} tasks are past their deadline waiting for ${skill}`),
                why: `Nobody accepted the ${step} handoff within ${minutes(coord.acceptWithinS[task.severity])} min (the limit for severity ${task.severity}).`,
                suggested: keepQueued,
              };
        case "shift_cut":
          if (task.severity < coord.shiftCutEscalateSeverity) return null;
          return {
            rule: "ESCALATE_SHIFT_CUT_REPAIR",
            headline: () => `${describe(task)}: ${step} was cut off when the shift ended`,
            why: `A severity ${task.severity} ${step} was dropped at shift end and its progress was lost.`,
            suggested: offShift ? waitForShift : keepQueued,
          };
        default:
          return null;
      }
    };

    let raise: Raise | null = null;
    if (isNew) {
      raise =
        (blocker === "no_skill"
          ? {
              rule: "ESCALATE_NO_SKILL_IN_CREW" as const,
              headline: () => `${describe(task)} needs ${step}, and nobody in the crew can do that`,
              why: `No worker in the crew has the ${skill} skill.`,
              suggested: { action: "ack" as const, label: "Take it over yourself, or add a worker with this skill" },
            }
          : fromAlert()) ??
        (prev
          ? {
              rule: "ESCALATE_SITUATION_CHANGED" as const,
              // Tasks that all just became blocked the same way (a shift ended) share one escalation.
              digestKey: changes.length === 1 && rank > prev.blockerRank ? `changed:${blocker}` : undefined,
              headline: (n: number) => (n === 1 ? `${describe(task)}: ${changes[0]}` : `${n} tasks changed: ${changes[0].replace(/^every worker who can \w+/, "every worker who can take them")}`),
              why: `Already raised for ${step}, and since then: ${changes.join("; ")}.`,
              suggested: offShift ? waitForShift : keepQueued,
            }
          : null);
    } else if (prev && tick >= Math.max(prev.tick, task.snoozeUntilTick) + ticksFor(coord.reminderAfterS)) {
      // Nothing changed for a long time. Counted from the last escalation, or from the end of a snooze.
      raise = {
        rule: "REMIND_STILL_WAITING",
        digestKey: `remind:${skill}`,
        headline: (n) => (n === 1 ? `Still waiting: ${describe(task)} needs ${step}, ${waitedMin} min since detection` : `${n} tasks are still waiting for ${skill}, nothing has changed`),
        why: `No change in the ${reminderHours} h since this task was last raised. Still waiting for ${step}.`,
        suggested: offShift ? waitForShift : keepQueued,
      };
    }
    if (!raise) continue;

    const level = "needs_decision" as const;
    const existing = raise.digestKey ? digests.get(raise.digestKey) : undefined;
    if (existing) {
      existing.taskIds.push(task.id);
      existing.headline = raise.headline(existing.taskIds.length);
      continue;
    }
    const decision = {
      kind: "escalate" as const,
      rule: raise.rule,
      level,
      taskIds: [task.id],
      headline: raise.headline(1),
      why: raise.why,
      suggested: raise.suggested,
      blocker,
      digestKey: raise.digestKey,
    };
    if (raise.digestKey) digests.set(raise.digestKey, decision);
    out.push(decision);
  }
  return out;
}

// ---------- Arien ----------

export const arienDispatcher: Dispatcher = (ctx) => {
  const decisions: DispatchDecision[] = escalations(ctx);

  const busyOn = new Map<string, string>();
  for (const task of ctx.tasks) if (task.workerId) busyOn.set(task.workerId, task.id);

  const remaining = ctx.tasks
    .filter((t) => isWaiting(t) && t.forcedWorkerId === null)
    .map((task) => ({ task, score: scoreTask(task, ctx.clock, ctx.coord) }))
    .sort(byPriority);
  const round: Round = { ctx, busyOn, remaining };

  // Greedy: the top task picks its best worker, then the next task picks from who is left.
  while (remaining.length > 0) {
    const top = remaining[0];
    const { all, ok } = candidatesFor(top.task, round);
    if (ok.length === 0) {
      decisions.push(holdDecision(top, all));
      remaining.shift();
      continue;
    }
    const best = ok[0];

    // Near-tie: if another task within a few points is closer to this worker, and this
    // worker is also that task's best pick, they take the closer one first.
    let pick = top;
    let pickCands = { all, ok };
    for (const other of remaining.slice(1)) {
      if (top.score.total - other.score.total > ctx.coord.nearTiePoints) break;
      const otherCands = candidatesFor(other.task, round);
      const otherBest = otherCands.ok[0];
      const currentTravel = pickCands.ok[0].travelS;
      if (otherBest && otherBest.workerId === best.workerId && Math.round(otherBest.travelS) < Math.round(currentTravel)) {
        pick = other;
        pickCands = otherCands;
      }
    }

    const step = stepOf(pick.task)!;
    const nearTie = pick !== top;
    decisions.push({
      kind: "assign",
      rule: nearTie ? "ASSIGN_NEAR_TIE_CLOSER" : "ASSIGN_SPECIALIST_NEAREST",
      taskId: pick.task.id,
      workerId: best.workerId,
      why:
        `${formatScore(pick.score)}. ` +
        (nearTie
          ? `${best.workerId} chosen: within ${ctx.coord.nearTiePoints} points of ${top.task.id} (${top.score.total}) and closer, ${Math.round(pickCands.ok[0].travelS)} s vs ${Math.round(best.travelS)} s.`
          : `${chosenBecause(ok, step)}.`) +
        skippedText(pickCands.all),
      score: pick.score,
      considered: pickCands.all.map(strip),
    });
    busyOn.set(best.workerId, pick.task.id);
    remaining.splice(remaining.indexOf(pick), 1);
  }

  return decisions;
};

// ---------- 7. naive baseline ----------

/**
 * "A whiteboard and a radio": oldest waiting task first, first free worker in crew
 * order who has the skill and is on shift. No severity, distance, or shift-end
 * checks, and no check that the battery will last the trip. No holds, no deadlines,
 * no escalations of its own.
 *
 * One bit of common sense: a drone sitting on its charger is left there until it is
 * full. Without that, a drone fetched with a dead battery is relaunched at once,
 * dies again, and the baseline never inspects anything.
 */
export const naiveDispatcher: Dispatcher = ({ clock, tasks, workers, busy }) => {
  const free = workers.filter((w) => !busy.has(w.id) && isAvailable(w, clock) && w.status !== "charging");
  const decisions: DispatchDecision[] = [];
  const queue = tasks.filter((t) => isWaiting(t) && t.forcedWorkerId === null).sort((a, b) => a.createdTick - b.createdTick);
  for (const task of queue) {
    const skill = skillFor(task)!;
    const i = free.findIndex((w) => hasSkill(w, skill) && !task.failedWorkerIds.includes(w.id));
    if (i === -1) continue;
    const [worker] = free.splice(i, 1);
    decisions.push({
      kind: "assign",
      rule: "ASSIGN_FIRST_FREE",
      taskId: task.id,
      workerId: worker.id,
      why: `Oldest waiting task. ${worker.id} is the first free worker with ${skill}. No other checks.`,
    });
  }
  return decisions;
};

/** Old name, kept so earlier code still reads. */
export const firstFreeDispatcher = naiveDispatcher;
