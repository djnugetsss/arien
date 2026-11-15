// Headless simulation loop. Each tick:
//   1. new faults become tasks
//   2. the dispatcher assigns free workers to waiting tasks (every assignment logs a "why")
//   3. free workers with nothing to do head home
//   4. workers move
//   5. tasks progress: arrive, work, change state, or get released if their worker drops out
//
// The dispatcher is pluggable. Phase 1-2 uses "first free worker". Phase 3 swaps in Arien's.
// Faults and repair-vs-replace outcomes use their own RNG streams, so changing the
// dispatcher never changes what breaks. That keeps the phase 4 comparison fair.

import { advance, createClock, formatSimTime, type Clock } from "./clock";
import { createFaultGenerator, type FaultConfig, type FaultGenerator } from "./faults";
import { createRng, seedToUint32, type Rng, type Seed } from "./rng";
import { createSite, type Site } from "./site";
import {
  DEFAULT_TASK_CONFIG,
  createTask,
  skillFor,
  stateAfterWork,
  transition,
  workSecondsFor,
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
  samePoint,
  sendTo,
  stepWorkers,
  type Worker,
} from "./workers";

// ---------- dispatch ----------

export interface Assignment {
  taskId: string;
  workerId: string;
  /** Short reason, printed in the log. Required for every decision (CLAUDE.md rule 4). */
  why: string;
}

export interface DispatchContext {
  clock: Clock;
  /** Creation order. */
  tasks: readonly Task[];
  /** Crew order. */
  workers: readonly Worker[];
  /** Ids of workers already on a task. */
  busy: ReadonlySet<string>;
}

export type Dispatcher = (ctx: DispatchContext) => Assignment[];

/**
 * The naive baseline: oldest waiting task first, first free worker in crew order
 * that has the skill. No distance, battery, shift-end, or severity checks.
 */
export const firstFreeDispatcher: Dispatcher = ({ clock, tasks, workers, busy }) => {
  const free = workers.filter((w) => !busy.has(w.id) && isAvailable(w, clock));
  const assignments: Assignment[] = [];
  for (const task of tasks) {
    if (task.workerId !== null) continue;
    const skill = skillFor(task);
    if (!skill) continue;
    const i = free.findIndex((w) => hasSkill(w, skill));
    if (i === -1) continue;
    const [worker] = free.splice(i, 1);
    assignments.push({ taskId: task.id, workerId: worker.id, why: `first free worker with ${skill}` });
  }
  return assignments;
};

// ---------- events ----------

export type SimEvent =
  | { tick: number; kind: "detected"; taskId: string }
  | { tick: number; kind: "assigned"; taskId: string; workerId: string; why: string }
  | { tick: number; kind: "arrived"; taskId: string; workerId: string; workS: number }
  | { tick: number; kind: "state"; taskId: string; from: TaskState; to: TaskState; workerId: string | null }
  | { tick: number; kind: "released"; taskId: string; workerId: string; why: string };

// ---------- sim ----------

export interface SimOptions {
  seed: Seed;
  site?: Site;
  /** Defaults to one drone, one ground robot, one technician. */
  crew?: Worker[];
  dispatcher?: Dispatcher;
  clock?: Clock;
  faultConfig?: Partial<FaultConfig>;
  taskConfig?: TaskConfig;
}

export interface Sim {
  site: Site;
  clock: Clock;
  workers: Worker[];
  tasks: Task[];
  events: SimEvent[];
  dispatcher: Dispatcher;
  taskConfig: TaskConfig;
  faults: FaultGenerator;
  outcomes: Rng;
}

export function defaultCrew(): Worker[] {
  return [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1")];
}

/** Separate stream for repair-vs-replace, derived from the seed. */
function outcomeSeed(seed: Seed): number {
  return seedToUint32(`outcomes:${seedToUint32(seed)}`);
}

export function createSim(options: SimOptions): Sim {
  const site = options.site ?? createSite();
  const crew = options.crew ?? defaultCrew();
  const ids = new Set(crew.map((w) => w.id));
  if (ids.size !== crew.length) throw new Error("Worker ids must be unique");
  return {
    site,
    clock: options.clock ?? createClock(),
    workers: crew,
    tasks: [],
    events: [],
    dispatcher: options.dispatcher ?? firstFreeDispatcher,
    taskConfig: options.taskConfig ?? DEFAULT_TASK_CONFIG,
    faults: createFaultGenerator(site, createRng(options.seed), options.faultConfig),
    outcomes: createRng(outcomeSeed(options.seed)),
  };
}

/** Advances the sim one tick. Mutates `sim` and returns this tick's events. */
export function stepSim(sim: Sim): SimEvent[] {
  sim.clock = advance(sim.clock);
  const tick = sim.clock.tick;
  const events: SimEvent[] = [];
  const workerIndex = new Map(sim.workers.map((w, i) => [w.id, i]));
  const taskIndex = new Map(sim.tasks.map((t, i) => [t.id, i]));

  // 1. Faults -> tasks.
  for (const fault of sim.faults.step(tick)) {
    const task = createTask(fault, sim.outcomes.chance(sim.taskConfig.replaceChance[fault.type]));
    taskIndex.set(task.id, sim.tasks.length);
    sim.tasks.push(task);
    events.push({ tick, kind: "detected", taskId: task.id });
  }

  // 2. Dispatch.
  const busy = new Set(sim.tasks.flatMap((t) => (t.workerId ? [t.workerId] : [])));
  const assignments = sim.dispatcher({ clock: sim.clock, tasks: sim.tasks, workers: sim.workers, busy });
  for (const a of assignments) {
    const ti = taskIndex.get(a.taskId);
    const wi = workerIndex.get(a.workerId);
    if (ti === undefined || wi === undefined) throw new Error(`Bad assignment ${a.taskId} -> ${a.workerId}`);
    let task = sim.tasks[ti];
    const worker = sim.workers[wi];
    const skill = skillFor(task);
    if (task.workerId !== null) throw new Error(`${task.id} already has ${task.workerId}`);
    if (busy.has(worker.id)) throw new Error(`${worker.id} is already busy`);
    if (!skill || !hasSkill(worker, skill)) throw new Error(`${worker.id} cannot do ${task.id} (${task.state})`);
    if (!isAvailable(worker, sim.clock)) throw new Error(`${worker.id} is not available`);
    if (!a.why) throw new Error(`Assignment ${a.taskId} -> ${a.workerId} has no why`);

    busy.add(worker.id);
    events.push({ tick, kind: "assigned", taskId: task.id, workerId: worker.id, why: a.why });
    if (task.state === "detected") {
      task = transition(task, "inspect");
      events.push({ tick, kind: "state", taskId: task.id, from: "detected", to: "inspect", workerId: worker.id });
    }
    sim.tasks[ti] = { ...task, workerId: worker.id, phase: "traveling" };
    sim.workers[wi] = sendTo(worker, task.target);
  }

  // 3. Free workers with nothing to do go home.
  sim.workers = sim.workers.map((w) =>
    !busy.has(w.id) && w.status !== "stranded" && w.target === null && !samePoint(w.position, w.home) ? sendTo(w, w.home) : w,
  );

  // 4. Move.
  sim.workers = stepWorkers(sim.workers, sim.clock);

  // 5. Progress tasks.
  for (let ti = 0; ti < sim.tasks.length; ti++) {
    const task = sim.tasks[ti];
    if (task.workerId === null) continue;
    const worker = sim.workers[workerIndex.get(task.workerId)!];

    if (worker.status === "stranded" || worker.status === "off_shift") {
      const why = worker.status === "stranded" ? "battery died" : "shift ended";
      events.push({ tick, kind: "released", taskId: task.id, workerId: worker.id, why });
      sim.tasks[ti] = { ...task, workerId: null, phase: "waiting", workLeftS: 0 }; // progress on this step is lost
      continue;
    }

    if (task.phase === "traveling") {
      if (samePoint(worker.position, task.target)) {
        const workS = workSecondsFor(task, sim.taskConfig);
        sim.tasks[ti] = { ...task, phase: "working", workLeftS: workS };
        events.push({ tick, kind: "arrived", taskId: task.id, workerId: worker.id, workS });
      }
      continue;
    }

    // Working.
    const workLeftS = task.workLeftS - sim.clock.tickSeconds;
    if (workLeftS > 0) {
      sim.tasks[ti] = { ...task, workLeftS };
      continue;
    }
    const to = stateAfterWork(task);
    const next = transition(task, to);
    sim.tasks[ti] = { ...next, workerId: null, phase: "waiting", workLeftS: 0, doneTick: to === "done" ? tick : null };
    events.push({ tick, kind: "state", taskId: task.id, from: task.state, to, workerId: worker.id });
  }

  sim.events.push(...events);
  return events;
}

export function runSim(options: SimOptions & { ticks: number }): Sim {
  const sim = createSim(options);
  for (let i = 0; i < options.ticks; i++) stepSim(sim);
  return sim;
}

// ---------- printing ----------

export function formatEvent(event: SimEvent, sim: Pick<Sim, "clock" | "tasks">): string {
  const task = sim.tasks.find((t) => t.id === event.taskId);
  const time = formatSimTime({ ...sim.clock, tick: event.tick });
  const head = `${time}  tick=${String(event.tick).padStart(4, "0")}  ${event.taskId}`;
  switch (event.kind) {
    case "detected":
      return `${head}  detected       ${task?.fault.type ?? ""} sev=${task?.fault.severity ?? ""}`;
    case "assigned":
      return `${head}  assigned       ${event.workerId}  why: ${event.why}`;
    case "arrived":
      return `${head}  arrived        ${event.workerId}  working ${Math.round(event.workS / 60)} min`;
    case "state":
      return `${head}  ${event.from} -> ${event.to}`.padEnd(head.length + 17) + (event.workerId ? `  ${event.workerId}` : "");
    case "released":
      return `${head}  released       ${event.workerId}  why: ${event.why}`;
  }
}
