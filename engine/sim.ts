// Headless simulation loop. Each tick:
//   0. the stand-in human answers escalations that have waited long enough
//   1. new faults become tasks, each offered as a "pickup" handoff
//   2. handoffs past their deadline are marked timed out
//   3. workers a person picked are assigned as soon as they are free
//   4. the dispatcher decides: assign, hold, escalate. Every decision gets a why record
//   5. free workers with nothing to do head home
//   6. workers move
//   7. tasks progress: arrive, work, change state, bounce, or lose their worker
//   8. a newly stranded worker gets a recovery job and an urgent escalation
//
// Everything here is the same for every dispatcher. Faults and outcomes come from
// their own RNG streams, so the dispatcher never changes what breaks. Only step 4
// differs between Arien and the naive baseline.

import { advance, createClock, formatSimTime, type Clock } from "./clock";
import {
  DEFAULT_COORDINATION_CONFIG,
  type CoordinationConfig,
  type DispatchDecision,
  type Dispatcher,
  type Escalation,
  type EscalationLevel,
  type HumanAction,
  type Rule,
  type SuggestedAction,
  type WhyRecord,
} from "./decisions";
import { arienDispatcher } from "./dispatcher";
import { createFaultGenerator, type Fault, type FaultConfig, type FaultGenerator } from "./faults";
import { createRng, seedToUint32, type Rng, type Seed } from "./rng";
import { createSite, type Site } from "./site";
import {
  DEFAULT_TASK_CONFIG,
  createRecoverTask,
  createTask,
  handoffKindFor,
  isWaiting,
  skillFor,
  stateAfterWork,
  stepOf,
  transition,
  workSecondsFor,
  type FaultOutcomes,
  type Handoff,
  type HandoffKind,
  type Resolution,
  type Task,
  type TaskConfig,
  type TaskState,
} from "./tasks";
import {
  createDrone,
  createGroundRobot,
  createTechnician,
  hasSkill,
  isAvailable,
  recoverWorker,
  samePoint,
  sendTo,
  stepWorkers,
  travelSeconds,
  type Worker,
} from "./workers";

// ---------- events: what happened (facts). The why log holds the reasons. ----------

export type HandoffFailure = "timed_out" | "dropped" | "late" | "bounced";

export type SimEvent =
  | { tick: number; kind: "detected"; taskId: string }
  | { tick: number; kind: "handoff_offered"; taskId: string; handoff: HandoffKind; deadlineTick: number; retry: boolean }
  | { tick: number; kind: "handoff_accepted"; taskId: string; handoff: HandoffKind; workerId: string; arriveByTick: number }
  | { tick: number; kind: "handoff_completed"; taskId: string; handoff: HandoffKind; workerId: string; workS: number }
  | { tick: number; kind: "handoff_failed"; taskId: string; handoff: HandoffKind; reason: HandoffFailure; workerId: string | null }
  | { tick: number; kind: "state"; taskId: string; from: TaskState; to: TaskState; workerId: string | null; resolution: Resolution | null }
  | { tick: number; kind: "released"; taskId: string; workerId: string; cause: string }
  | { tick: number; kind: "stranded"; taskId: string; workerId: string }
  | { tick: number; kind: "recovered"; taskId: string; workerId: string }
  | { tick: number; kind: "escalated"; taskId: string; escalationId: string; level: EscalationLevel }
  | { tick: number; kind: "resolved"; taskId: string; escalationId: string; by: string; action: string };

// ---------- sim ----------

export interface SimOptions {
  seed: Seed;
  site?: Site;
  /** Defaults to one drone, one ground robot, one technician. */
  crew?: Worker[];
  /** Defaults to Arien's dispatcher. */
  dispatcher?: Dispatcher;
  clock?: Clock;
  faultConfig?: Partial<FaultConfig>;
  taskConfig?: Partial<TaskConfig>;
  coord?: Partial<CoordinationConfig>;
  /** Stand-in human that approves the suggested action after a fixed delay. On by default. */
  autoHuman?: boolean;
}

export interface Sim {
  site: Site;
  clock: Clock;
  workers: Worker[];
  tasks: Task[];
  events: SimEvent[];
  /** The why log. */
  decisions: WhyRecord[];
  escalations: Escalation[];
  dispatcher: Dispatcher;
  taskConfig: TaskConfig;
  coord: CoordinationConfig;
  autoHuman: boolean;
  faults: FaultGenerator;
  outcomes: Rng;
}

export function defaultCrew(): Worker[] {
  return [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1")];
}

/** Separate stream for outcomes (replace, unconfirmed, false alarm), derived from the seed. */
function outcomeSeed(seed: Seed): number {
  return seedToUint32(`outcomes:${seedToUint32(seed)}`);
}

export function createSim(options: SimOptions): Sim {
  const site = options.site ?? createSite();
  const crew = options.crew ?? defaultCrew();
  if (new Set(crew.map((w) => w.id)).size !== crew.length) throw new Error("Worker ids must be unique");
  return {
    site,
    clock: options.clock ?? createClock(),
    workers: [...crew],
    tasks: [],
    events: [],
    decisions: [],
    escalations: [],
    dispatcher: options.dispatcher ?? arienDispatcher,
    taskConfig: { ...DEFAULT_TASK_CONFIG, ...options.taskConfig },
    coord: { ...DEFAULT_COORDINATION_CONFIG, ...options.coord },
    autoHuman: options.autoHuman ?? true,
    faults: createFaultGenerator(site, createRng(options.seed), options.faultConfig),
    outcomes: createRng(outcomeSeed(options.seed)),
  };
}

// ---------- small helpers ----------

const ticksFor = (sim: Sim, seconds: number) => Math.ceil(seconds / sim.clock.tickSeconds);

// Tasks are only ever appended, so an id -> position index stays valid. Kept outside
// the Sim object so the sim state stays plain data.
const taskIndexes = new WeakMap<Sim, Map<string, number>>();

function taskIndexMap(sim: Sim): Map<string, number> {
  let index = taskIndexes.get(sim);
  if (!index) taskIndexes.set(sim, (index = new Map()));
  for (let i = index.size; i < sim.tasks.length; i++) index.set(sim.tasks[i].id, i);
  return index;
}

function taskIndex(sim: Sim, taskId: string): number {
  const i = taskIndexMap(sim).get(taskId);
  if (i === undefined) throw new Error(`No task ${taskId}`);
  return i;
}

function workerIndex(sim: Sim, workerId: string): number {
  const i = sim.workers.findIndex((w) => w.id === workerId);
  if (i === -1) throw new Error(`No worker ${workerId}`);
  return i;
}

function patchTask(sim: Sim, taskId: string, patch: Partial<Task>): Task {
  const i = taskIndex(sim, taskId);
  sim.tasks[i] = { ...sim.tasks[i], ...patch };
  return sim.tasks[i];
}

function logWhy(sim: Sim, record: Omit<WhyRecord, "tick">): void {
  if (!record.why) throw new Error(`Decision ${record.kind} on ${record.taskId} has no why`);
  sim.decisions.push({ tick: sim.clock.tick, ...record });
}

/** A fresh handoff for the step the task is on, with a deadline set by severity. */
function offer(sim: Sim, task: Task, carry: { failCount?: number } = {}): Handoff {
  return {
    kind: handoffKindFor(task),
    offeredTick: sim.clock.tick,
    deadlineTick: sim.clock.tick + ticksFor(sim, sim.coord.acceptWithinS[task.severity]),
    workerId: null,
    acceptedTick: null,
    arriveByTick: null,
    completedTick: null,
    failCount: carry.failCount ?? 0,
    timedOut: false,
  };
}

function offerEvent(sim: Sim, task: Task, retry: boolean): void {
  const h = task.handoff!;
  sim.events.push({ tick: sim.clock.tick, kind: "handoff_offered", taskId: task.id, handoff: h.kind, deadlineTick: h.deadlineTick, retry });
}

/**
 * Adds a fault by hand and opens its task. The sim uses this for generated faults.
 * Tests and crew mode use it to place specific faults. `fault.startTick` should be
 * the tick it appears on (the current tick, or the next one if called between steps).
 */
export function injectFault(sim: Sim, fault: Fault, outcomes: Partial<FaultOutcomes> = {}): Task {
  const task = createTask(fault, outcomes);
  if (taskIndexMap(sim).has(task.id)) throw new Error(`Fault ${fault.id} already exists`);
  const base = offer(sim, task);
  const withHandoff = { ...task, handoff: { ...base, offeredTick: fault.startTick, deadlineTick: base.deadlineTick + (fault.startTick - sim.clock.tick) } };
  sim.tasks.push(withHandoff);
  sim.events.push({ tick: fault.startTick, kind: "detected", taskId: task.id });
  sim.events.push({ tick: fault.startTick, kind: "handoff_offered", taskId: task.id, handoff: withHandoff.handoff.kind, deadlineTick: withHandoff.handoff.deadlineTick, retry: false });
  return withHandoff;
}

// ---------- assigning ----------

function assign(sim: Sim, taskId: string, workerId: string, forced: boolean): void {
  const tick = sim.clock.tick;
  let task = sim.tasks[taskIndex(sim, taskId)];
  const wi = workerIndex(sim, workerId);
  const worker = sim.workers[wi];
  const skill = skillFor(task);

  if (task.workerId !== null) throw new Error(`${task.id} already has ${task.workerId}`);
  if (sim.tasks.some((t) => t.workerId === worker.id)) throw new Error(`${worker.id} is already busy`);
  if (!skill || !hasSkill(worker, skill)) throw new Error(`${worker.id} cannot do ${task.id} (${task.state})`);
  if (!isAvailable(worker, sim.clock)) throw new Error(`${worker.id} is not available`);
  if (!forced && task.failedWorkerIds.includes(worker.id)) throw new Error(`${worker.id} already failed ${task.id}`);

  if (task.state === "detected") {
    task = patchTask(sim, task.id, { state: transition(task, "inspect").state });
    sim.events.push({ tick, kind: "state", taskId: task.id, from: "detected", to: "inspect", workerId: worker.id, resolution: null });
  }
  const base = task.handoff ?? offer(sim, task);
  const arriveByTick = tick + ticksFor(sim, travelSeconds(worker, task.target)) + ticksFor(sim, sim.coord.arrivalGraceS);
  const handoff: Handoff = { ...base, workerId: worker.id, acceptedTick: tick, arriveByTick, completedTick: null };
  patchTask(sim, task.id, { workerId: worker.id, phase: "traveling", handoff, holdKey: null, alert: null, forcedWorkerId: null });
  sim.events.push({ tick, kind: "handoff_accepted", taskId: task.id, handoff: handoff.kind, workerId: worker.id, arriveByTick });
  sim.workers[wi] = sendTo(worker, task.target);
}

// ---------- escalations ----------

function openEscalation(
  sim: Sim,
  spec: { rule: Rule; level: EscalationLevel; taskIds: string[]; workerId?: string; headline: string; why: string; suggested: SuggestedAction; digestKey?: string },
): Escalation {
  const tick = sim.clock.tick;

  // Tasks stuck for the same reason join the open digest instead of opening a new one.
  let esc = spec.digestKey ? sim.escalations.find((e) => e.status === "open" && e.digestKey === spec.digestKey) : undefined;
  if (esc) {
    esc.taskIds.push(...spec.taskIds);
    esc.headline = `${esc.taskIds.length} tasks: ${spec.why}`;
  } else {
    const tried = sim.decisions
      .filter((d) => spec.taskIds.includes(d.taskId))
      .slice(-4)
      .map((d) => `${formatSimTime({ ...sim.clock, tick: d.tick })} ${d.taskId} ${d.kind}: ${d.why}`);
    esc = {
      id: `E${String(sim.escalations.length + 1).padStart(4, "0")}`,
      openedTick: tick,
      level: spec.level,
      rule: spec.rule,
      headline: spec.headline,
      why: spec.why,
      taskIds: [...spec.taskIds],
      workerId: spec.workerId ?? null,
      digestKey: spec.digestKey ?? null,
      tried,
      suggested: spec.suggested,
      options: [
        { action: "approve", label: spec.suggested.label },
        { action: "reassign", label: "Send a worker you pick (they still need the skill)" },
        { action: "take_over", label: "Handle it outside the system and mark it done" },
        { action: "wait", label: "Snooze until a time you pick" },
      ],
      defaultAtTick: tick + ticksFor(sim, sim.coord.autoHumanDelayS),
      status: "open",
      resolvedTick: null,
      resolvedBy: null,
      resolution: null,
    };
    sim.escalations.push(esc);
  }

  for (const taskId of spec.taskIds) {
    logWhy(sim, { kind: "escalate", rule: spec.rule, taskId, workerId: spec.workerId, why: `${spec.headline}. ${spec.why} Suggested: ${spec.suggested.label}.` });
    sim.events.push({ tick, kind: "escalated", taskId, escalationId: esc.id, level: spec.level });
    if (spec.level !== "notice") patchTask(sim, taskId, { escalationId: esc.id, alert: null });
  }

  // A notice needs no answer.
  if (spec.level === "notice") {
    Object.assign(esc, { status: "resolved", resolvedTick: tick, resolvedBy: "system", resolution: "notice only" });
  }
  return esc;
}

/**
 * Applies a person's answer to an escalation. Every action is logged with its tick,
 * so replaying the same actions on the same seed reproduces the run.
 */
export function applyHumanAction(sim: Sim, action: HumanAction): void {
  const tick = sim.clock.tick;
  const esc = sim.escalations.find((e) => e.id === action.escalationId);
  if (!esc) throw new Error(`No escalation ${action.escalationId}`);
  if (esc.status !== "open") throw new Error(`${esc.id} is already resolved`);
  const by = action.by ?? "human";
  const open = esc.taskIds.filter((id) => sim.tasks[taskIndex(sim, id)].state !== "done");
  let resolution: string;

  const snooze = (untilTick: number, rule: Rule, label: string) => {
    for (const taskId of open) {
      const task = sim.tasks[taskIndex(sim, taskId)];
      const window = ticksFor(sim, sim.coord.acceptWithinS[task.severity]);
      const handoff = task.handoff && task.workerId === null ? { ...task.handoff, deadlineTick: untilTick + window, timedOut: false } : task.handoff;
      patchTask(sim, taskId, { snoozeUntilTick: untilTick, handoff, alert: null });
      logWhy(sim, { kind: "resolve", rule, taskId, why: `${by} answered ${esc.id}: ${label}. No new escalation before ${formatSimTime({ ...sim.clock, tick: untilTick })}.` });
    }
  };

  if (action.action === "approve" && esc.suggested.action === "ack") {
    for (const taskId of esc.taskIds) logWhy(sim, { kind: "resolve", rule: "HUMAN_APPROVE", taskId, why: `${by} acknowledged ${esc.id}: ${esc.suggested.label}.` });
    resolution = esc.suggested.label;
  } else if (action.action === "approve" && esc.suggested.action === "wait") {
    snooze(esc.suggested.untilTick, "HUMAN_APPROVE", esc.suggested.label);
    resolution = esc.suggested.label;
  } else if (action.action === "wait") {
    if (action.untilTick === undefined || action.untilTick <= tick) throw new Error("wait needs an untilTick in the future");
    resolution = `Wait until ${formatSimTime({ ...sim.clock, tick: action.untilTick })}`;
    snooze(action.untilTick, "HUMAN_WAIT", resolution);
  } else if (action.action === "reassign") {
    if (open.length !== 1) throw new Error("reassign works on an escalation with exactly one open task");
    const task = sim.tasks[taskIndex(sim, open[0])];
    const worker = sim.workers[workerIndex(sim, action.workerId ?? "")];
    const skill = skillFor(task)!;
    if (!hasSkill(worker, skill)) throw new Error(`${worker.id} cannot ${skill}: capability cannot be overridden`);
    if (task.workerId !== null) throw new Error(`${task.id} is already with ${task.workerId}`);
    patchTask(sim, task.id, { forcedWorkerId: worker.id });
    resolution = `Send ${worker.id}`;
    logWhy(sim, {
      kind: "override",
      rule: "OVERRIDE_REASSIGN",
      taskId: task.id,
      workerId: worker.id,
      why: `${by} answered ${esc.id}: send ${worker.id} to ${stepOf(task)} as soon as they are free. Skips the battery, shift-length, and technician-guard checks.`,
    });
  } else {
    // take_over: the person handles it outside the system.
    for (const taskId of open) {
      const task = sim.tasks[taskIndex(sim, taskId)];
      if (task.kind === "recover" && task.recoverWorkerId) {
        const wi = workerIndex(sim, task.recoverWorkerId);
        sim.workers[wi] = recoverWorker(sim.workers[wi]);
      }
      patchTask(sim, taskId, { state: "done", phase: "waiting", workerId: null, workLeftS: 0, handoff: null, resolution: "taken_over", doneTick: tick, forcedWorkerId: null });
      sim.events.push({ tick, kind: "state", taskId, from: task.state, to: "done", workerId: null, resolution: "taken_over" });
      logWhy(sim, { kind: "override", rule: "OVERRIDE_TAKE_OVER", taskId, why: `${by} answered ${esc.id}: handled outside the system and marked done${task.workerId ? `, ${task.workerId} is freed` : ""}.` });
    }
    resolution = "Taken over";
  }

  Object.assign(esc, { status: "resolved", resolvedTick: tick, resolvedBy: by, resolution });
  for (const taskId of esc.taskIds) {
    patchTask(sim, taskId, { escalationId: null });
    sim.events.push({ tick, kind: "resolved", taskId, escalationId: esc.id, by, action: action.action });
  }
}

// ---------- failure handling ----------

/** The handoff for this step failed after it was accepted. One retry, then it is flagged. */
function failHandoff(sim: Sim, task: Task, reason: Exclude<HandoffFailure, "timed_out">, workerId: string, detail: string, patch: Partial<Task>): void {
  const tick = sim.clock.tick;
  const failCount = (task.handoff?.failCount ?? 0) + 1;
  const step = stepOf(task);
  sim.events.push({ tick, kind: "handoff_failed", taskId: task.id, handoff: handoffKindFor(task), reason, workerId });

  const retryFailed = failCount >= 2;
  const next = patchTask(sim, task.id, { ...patch, workerId: null, phase: "waiting", workLeftS: 0, alert: retryFailed ? "retry_failed" : task.alert });
  patchTask(sim, task.id, { handoff: offer(sim, next, { failCount }) });
  offerEvent(sim, sim.tasks[taskIndex(sim, task.id)], true);

  if (retryFailed) {
    logWhy(sim, { kind: "handoff", rule: "HANDOFF_RETRY_FAILED", taskId: task.id, workerId, why: `${detail} That is the second failed handoff for ${step}, so the retry is used up.` });
  } else {
    const rule = reason === "dropped" ? "RETRY_AFTER_DROP" : reason === "late" ? "RETRY_AFTER_LATE" : "RETRY_AFTER_BOUNCE";
    logWhy(sim, { kind: "retry", rule, taskId: task.id, workerId, why: `${detail} Handoff for ${step} failed (${reason}). Back in the queue for one retry with the next-best worker.` });
  }
}

// ---------- the tick ----------

/** Advances the sim one tick. Mutates `sim` and returns this tick's events. */
export function stepSim(sim: Sim): SimEvent[] {
  sim.clock = advance(sim.clock);
  const tick = sim.clock.tick;
  const firstEvent = sim.events.length;

  // 0. Stand-in human.
  if (sim.autoHuman) {
    for (const esc of sim.escalations) {
      if (esc.status === "open" && esc.defaultAtTick <= tick) applyHumanAction(sim, { escalationId: esc.id, action: "approve", by: "auto-human" });
    }
  }

  // 1. Faults -> tasks. Outcomes are always drawn in the same order, used or not.
  for (const fault of sim.faults.step(tick)) {
    const needsReplace = sim.outcomes.chance(sim.taskConfig.replaceChance[fault.type]);
    const unconfirmed = sim.outcomes.chance(sim.taskConfig.unconfirmedChance);
    const falseAlarm = sim.outcomes.chance(sim.taskConfig.falseAlarmChance);
    injectFault(sim, fault, { needsReplace, robotCanConfirm: !unconfirmed, falseAlarm });
  }

  // 2. Handoffs nobody accepted in time.
  for (const task of sim.tasks) {
    const h = task.handoff;
    if (!isWaiting(task) || !h || h.timedOut || tick <= h.deadlineTick) continue;
    patchTask(sim, task.id, { handoff: { ...h, timedOut: true }, alert: task.alert ?? "timed_out" });
    sim.events.push({ tick, kind: "handoff_failed", taskId: task.id, handoff: h.kind, reason: "timed_out", workerId: null });
    const limitMin = Math.round(sim.coord.acceptWithinS[task.severity] / 60);
    logWhy(sim, { kind: "handoff", rule: "HANDOFF_TIMED_OUT", taskId: task.id, why: `Nobody accepted the ${stepOf(task)} handoff within ${limitMin} min, the limit for severity ${task.severity}.` });
  }

  // 3. Workers a person picked go as soon as they are free.
  const busy = () => new Set(sim.tasks.flatMap((t) => (t.workerId ? [t.workerId] : [])));
  for (const task of sim.tasks) {
    if (!isWaiting(task) || !task.forcedWorkerId) continue;
    const worker = sim.workers[workerIndex(sim, task.forcedWorkerId)];
    if (!busy().has(worker.id) && isAvailable(worker, sim.clock)) assign(sim, task.id, worker.id, true);
  }

  // 4. Dispatch.
  const decisions: DispatchDecision[] = sim.dispatcher({
    clock: sim.clock,
    tasks: sim.tasks,
    workers: sim.workers,
    busy: busy(),
    coord: sim.coord,
    taskConfig: sim.taskConfig,
  });
  for (const d of decisions) {
    if (d.kind === "assign") {
      logWhy(sim, { kind: "assign", rule: d.rule, taskId: d.taskId, workerId: d.workerId, score: d.score, considered: d.considered, why: d.why });
      assign(sim, d.taskId, d.workerId, false);
    } else if (d.kind === "hold") {
      // Logged when the reason first applies and again only when it changes.
      if (sim.tasks[taskIndex(sim, d.taskId)].holdKey === d.key) continue;
      patchTask(sim, d.taskId, { holdKey: d.key });
      logWhy(sim, { kind: "hold", rule: d.rule, taskId: d.taskId, score: d.score, considered: d.considered, why: d.why });
    } else {
      const fresh = d.taskIds.filter((id) => d.level === "notice" || sim.tasks[taskIndex(sim, id)].escalationId === null);
      if (fresh.length > 0) openEscalation(sim, { ...d, taskIds: fresh });
    }
  }

  // 5. Free workers with nothing to do go home.
  const busyNow = busy();
  sim.workers = sim.workers.map((w) =>
    !busyNow.has(w.id) && w.status !== "stranded" && w.target === null && !samePoint(w.position, w.home) ? sendTo(w, w.home) : w,
  );

  // 6. Move.
  sim.workers = stepWorkers(sim.workers, sim.clock);

  // 7. Progress tasks.
  for (let ti = 0, count = sim.tasks.length; ti < count; ti++) {
    const task = sim.tasks[ti];
    if (task.workerId === null) continue;
    const wi = workerIndex(sim, task.workerId);
    const worker = sim.workers[wi];
    const step = stepOf(task)!;

    // The worker dropped out: battery died, or their shift ended.
    if (worker.status === "stranded" || worker.status === "off_shift") {
      const stranded = worker.status === "stranded";
      const cause = stranded ? "battery died" : "shift ended";
      sim.events.push({ tick, kind: "released", taskId: task.id, workerId: worker.id, cause });
      if (task.phase === "traveling") {
        failHandoff(sim, task, "dropped", worker.id, `${worker.id}'s ${cause} on the way to ${step}.`, { interrupted: true });
      } else {
        const cutRepair = !stranded && (task.state === "repair" || task.state === "replace") && task.kind === "fault";
        const next = patchTask(sim, task.id, { workerId: null, phase: "waiting", workLeftS: 0, interrupted: true, alert: cutRepair ? "shift_cut" : task.alert });
        patchTask(sim, task.id, { handoff: offer(sim, next, { failCount: task.handoff?.failCount ?? 0 }) });
        offerEvent(sim, sim.tasks[taskIndex(sim, task.id)], true);
        logWhy(sim, {
          kind: "release",
          rule: stranded ? "RELEASE_BATTERY_DIED" : "RELEASE_SHIFT_ENDED",
          taskId: task.id,
          workerId: worker.id,
          why: `${worker.id}'s ${cause} partway through ${step}. Progress on this step is lost. Back in the queue with +${sim.coord.interruptedBonus} priority.`,
        });
      }
      continue;
    }

    if (task.phase === "traveling") {
      const h = task.handoff!;
      if (samePoint(worker.position, task.target)) {
        const workS = workSecondsFor(task, sim.taskConfig);
        patchTask(sim, task.id, { phase: "working", workLeftS: workS, handoff: { ...h, completedTick: tick } });
        sim.events.push({ tick, kind: "handoff_completed", taskId: task.id, handoff: h.kind, workerId: worker.id, workS });
      } else if (h.arriveByTick !== null && tick > h.arriveByTick) {
        failHandoff(sim, task, "late", worker.id, `${worker.id} did not arrive within travel time plus ${Math.round(sim.coord.arrivalGraceS / 60)} min.`, {
          failedWorkerIds: [...task.failedWorkerIds, worker.id],
        });
        sim.workers[wi] = { ...worker, target: null };
      }
      continue;
    }

    // Working.
    const workLeftS = task.workLeftS - sim.clock.tickSeconds;
    if (workLeftS > 0) {
      patchTask(sim, task.id, { workLeftS });
      continue;
    }

    if (task.kind === "recover") {
      const si = workerIndex(sim, task.recoverWorkerId!);
      sim.workers[si] = recoverWorker(sim.workers[si]);
      patchTask(sim, task.id, { state: "done", workerId: null, phase: "waiting", workLeftS: 0, handoff: null, interrupted: false, resolution: "recovered", doneTick: tick });
      sim.events.push({ tick, kind: "state", taskId: task.id, from: task.state, to: "done", workerId: worker.id, resolution: "recovered" });
      sim.events.push({ tick, kind: "recovered", taskId: task.id, workerId: task.recoverWorkerId! });
      continue;
    }

    // A robot's verify can come back "unconfirmed". Only a person's verify is always conclusive.
    if (task.state === "verify" && !task.robotCanConfirm && !worker.human) {
      failHandoff(sim, task, "bounced", worker.id, `${worker.id} could not confirm the fault.`, { failedWorkerIds: [...task.failedWorkerIds, worker.id] });
      continue;
    }

    const falseAlarm = task.state === "verify" && task.falseAlarm;
    const to: TaskState = falseAlarm ? "done" : stateAfterWork(task);
    const resolution: Resolution | null = to !== "done" ? null : falseAlarm ? "false_alarm" : task.state === "replace" ? "replaced" : "repaired";
    const moved = transition(task, to);
    const next = patchTask(sim, task.id, {
      state: moved.state,
      workerId: null,
      phase: "waiting",
      workLeftS: 0,
      interrupted: false,
      failedWorkerIds: [],
      holdKey: null,
      resolution,
      doneTick: to === "done" ? tick : null,
      handoff: null,
    });
    sim.events.push({ tick, kind: "state", taskId: task.id, from: task.state, to, workerId: worker.id, resolution });
    if (to !== "done") {
      patchTask(sim, task.id, { handoff: offer(sim, next) });
      offerEvent(sim, sim.tasks[taskIndex(sim, task.id)], false);
    }
  }

  // 8. Newly stranded workers: a recovery job, and an urgent escalation.
  for (const worker of sim.workers) {
    if (worker.status !== "stranded") continue;
    if (sim.tasks.some((t) => t.kind === "recover" && t.recoverWorkerId === worker.id && t.state !== "done")) continue;
    const seq = sim.tasks.filter((t) => t.kind === "recover").length + 1;
    const job = createRecoverTask(seq, worker, tick, sim.taskConfig);
    sim.tasks.push({ ...job, handoff: offer(sim, job) });
    sim.events.push({ tick, kind: "stranded", taskId: job.id, workerId: worker.id });
    offerEvent(sim, sim.tasks[sim.tasks.length - 1], false);
    openEscalation(sim, {
      rule: "ESCALATE_STRANDED",
      level: "urgent",
      taskIds: [job.id],
      workerId: worker.id,
      headline: `${worker.id} is stranded with a dead battery`,
      why: `${worker.id} ran out of battery away from home and cannot move.`,
      suggested: { action: "ack", label: `Recovery job ${job.id} is queued for a worker with the recover skill` },
    });
  }

  return sim.events.slice(firstEvent);
}

export function runSim(options: SimOptions & { ticks: number }): Sim {
  const sim = createSim(options);
  for (let i = 0; i < options.ticks; i++) stepSim(sim);
  return sim;
}

// ---------- printing ----------

export function formatEvent(event: SimEvent, clock: Clock): string {
  const head = `${formatSimTime({ ...clock, tick: event.tick })}  tick=${String(event.tick).padStart(5, "0")}  ${event.taskId}  `;
  switch (event.kind) {
    case "detected":
      return `${head}detected`;
    case "handoff_offered":
      return `${head}handoff offered    ${event.handoff}${event.retry ? " (retry)" : ""}, accept by tick ${event.deadlineTick}`;
    case "handoff_accepted":
      return `${head}handoff accepted   ${event.handoff} by ${event.workerId}, arrive by tick ${event.arriveByTick}`;
    case "handoff_completed":
      return `${head}handoff completed  ${event.handoff}, ${event.workerId} on site, ${Math.round(event.workS / 60)} min of work`;
    case "handoff_failed":
      return `${head}handoff FAILED     ${event.handoff}: ${event.reason}${event.workerId ? ` (${event.workerId})` : ""}`;
    case "state":
      return `${head}${event.from} -> ${event.to}${event.resolution ? ` (${event.resolution})` : ""}${event.workerId ? `  ${event.workerId}` : ""}`;
    case "released":
      return `${head}released           ${event.workerId}: ${event.cause}`;
    case "stranded":
      return `${head}stranded           ${event.workerId}, recovery job created`;
    case "recovered":
      return `${head}recovered          ${event.workerId} is back home, charging`;
    case "escalated":
      return `${head}escalated          ${event.escalationId} (${event.level})`;
    case "resolved":
      return `${head}resolved           ${event.escalationId} by ${event.by}: ${event.action}`;
  }
}
