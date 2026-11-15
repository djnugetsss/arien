// Whole-run checks: determinism, fair physics, and lifecycle rules that must hold
// for every task under both dispatchers. Rule-by-rule tests are in dispatcher.test.ts.
import { describe, expect, it } from "vitest";
import { formatDecision, type Dispatcher } from "./decisions";
import { arienDispatcher, naiveDispatcher } from "./dispatcher";
import { runFaultLog } from "./faults";
import { createSim, formatEvent, runSim, stepSim, type Sim, type SimEvent } from "./sim";
import { NEXT_STATES, type TaskState } from "./tasks";
import { createDrone, createGroundRobot, createTechnician } from "./workers";

const DAY = 8640;
const DISPATCHERS: Array<[string, Dispatcher]> = [
  ["arien", arienDispatcher],
  ["naive", naiveDispatcher],
];
const fullLog = (sim: Sim) => [...sim.events.map((e) => formatEvent(e, sim.clock)), ...sim.decisions.map((d) => formatDecision(d, sim.clock))].join("\n");
const stateEvents = (sim: Sim, taskId: string) => sim.events.filter((e): e is Extract<SimEvent, { kind: "state" }> => e.kind === "state" && e.taskId === taskId);
const bigCrew = () => [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1"), createTechnician("T2")];

describe.each(DISPATCHERS)("sim determinism (%s)", (_name, dispatcher) => {
  it("same seed gives a byte-identical event log and why log over one sim day", () => {
    const a = runSim({ seed: "arien-demo", ticks: DAY, dispatcher });
    const b = runSim({ seed: "arien-demo", ticks: DAY, dispatcher });
    expect(a.events.length).toBeGreaterThan(100);
    expect(fullLog(a)).toBe(fullLog(b));
    expect(a.tasks).toEqual(b.tasks);
    expect(a.workers).toEqual(b.workers);
    expect(a.escalations).toEqual(b.escalations);
  });

  it("different seeds give different logs", () => {
    expect(fullLog(runSim({ seed: 1, ticks: DAY, dispatcher }))).not.toBe(fullLog(runSim({ seed: 2, ticks: DAY, dispatcher })));
  });

  it("holds across many seeds", () => {
    for (let seed = 0; seed < 8; seed++) {
      expect(fullLog(runSim({ seed, ticks: 5000, dispatcher }))).toBe(fullLog(runSim({ seed, ticks: 5000, dispatcher })));
    }
  });

  it("stepping one tick at a time matches runSim", () => {
    const sim = createSim({ seed: 9, dispatcher });
    for (let i = 0; i < DAY; i++) stepSim(sim);
    expect(fullLog(sim)).toBe(fullLog(runSim({ seed: 9, ticks: DAY, dispatcher })));
  });
});

describe("sim: faults and outcomes do not depend on the dispatcher", () => {
  const idle: Dispatcher = () => [];
  const physics = (sim: Sim) => sim.tasks.filter((t) => t.kind === "fault").map((t) => [t.fault, t.needsReplace, t.robotCanConfirm, t.falseAlarm]);

  it("fault tasks match the fault log exactly", () => {
    const sim = runSim({ seed: 42, ticks: DAY });
    expect(sim.tasks.filter((t) => t.kind === "fault").map((t) => t.fault)).toEqual(runFaultLog({ seed: 42, ticks: DAY }));
  });

  it("Arien, naive, and a dispatcher that does nothing all see the same faults and outcomes", () => {
    const arien = runSim({ seed: 42, ticks: DAY });
    const naive = runSim({ seed: 42, ticks: DAY, dispatcher: naiveDispatcher });
    const lazy = runSim({ seed: 42, ticks: DAY, dispatcher: idle });
    expect(physics(naive)).toEqual(physics(arien));
    expect(physics(lazy)).toEqual(physics(arien));
    expect(lazy.tasks.every((t) => t.state === "detected")).toBe(true);
  });

  it("the unconfirmed and false-alarm outcomes really occur", () => {
    const tasks = runSim({ seed: 42, ticks: 10 * DAY, dispatcher: idle }).tasks;
    expect(tasks.some((t) => !t.robotCanConfirm)).toBe(true);
    expect(tasks.some((t) => t.falseAlarm)).toBe(true);
    expect(tasks.filter((t) => t.falseAlarm).every((t) => !t.robotCanConfirm)).toBe(true);
  });
});

describe.each(DISPATCHERS)("sim lifecycle rules (%s)", (_name, dispatcher) => {
  const sims = [1, 2, "arien-demo"].map((seed) => runSim({ seed, ticks: 3 * DAY, crew: bigCrew(), dispatcher }));

  it("every state change is a legal move, in order", () => {
    for (const sim of sims) {
      for (const task of sim.tasks) {
        let state: TaskState = task.kind === "recover" ? "repair" : "detected";
        for (const e of stateEvents(sim, task.id)) {
          expect(e.from).toBe(state);
          expect(NEXT_STATES[state]).toContain(e.to);
          state = e.to;
        }
        expect(task.state).toBe(state);
      }
    }
  });

  it("done fault tasks went inspect -> verify -> repair, replace, or false alarm -> done", () => {
    const resolutions = new Set<string>();
    for (const sim of sims) {
      for (const task of sim.tasks.filter((t) => t.kind === "fault" && t.state === "done")) {
        const path = stateEvents(sim, task.id).map((e) => e.to);
        resolutions.add(task.resolution!);
        if (task.resolution === "false_alarm") expect(path).toEqual(["inspect", "verify", "done"]);
        else expect(path).toEqual(["inspect", "verify", task.needsReplace ? "replace" : "repair", "done"]);
        expect(task.resolution).toBe(task.falseAlarm ? "false_alarm" : task.needsReplace ? "replaced" : "repaired");
        expect(task.doneTick).toBeGreaterThan(task.createdTick);
        expect(task.handoff).toBeNull();
      }
    }
    expect(resolutions).toEqual(new Set(["repaired", "replaced", "false_alarm"]));
  });

  it("each step is finished by a worker with the right skill", () => {
    for (const sim of sims) {
      const skills = new Map(sim.workers.map((w) => [w.id, w.skills]));
      const kinds = new Map(sim.tasks.map((t) => [t.id, t.kind]));
      for (const e of sim.events) {
        if (e.kind !== "state" || e.from === "detected") continue;
        expect(skills.get(e.workerId!)).toContain(kinds.get(e.taskId) === "recover" ? "recover" : e.from);
      }
    }
  });

  it("only a person closes a false alarm", () => {
    for (const sim of sims) {
      const human = new Map(sim.workers.map((w) => [w.id, w.human]));
      for (const e of sim.events) {
        if (e.kind === "state" && e.resolution === "false_alarm") expect(human.get(e.workerId!)).toBe(true);
      }
    }
  });

  it("handoffs are offered before they are accepted, and accepted before they complete", () => {
    for (const sim of sims) {
      const stage = new Map<string, "offered" | "accepted" | "completed">();
      for (const e of sim.events) {
        if (e.kind === "handoff_offered") stage.set(e.taskId, "offered");
        if (e.kind === "handoff_accepted") {
          expect(stage.get(e.taskId)).toBe("offered");
          stage.set(e.taskId, "accepted");
        }
        if (e.kind === "handoff_completed") {
          expect(stage.get(e.taskId)).toBe("accepted");
          stage.set(e.taskId, "completed");
        }
      }
    }
  });

  it("a worker who failed a step is never given that step again", () => {
    for (const sim of sims) {
      const failed = new Set<string>();
      for (const e of sim.events) {
        if (e.kind === "state") for (const key of [...failed]) if (key.startsWith(`${e.taskId}|`)) failed.delete(key);
        if (e.kind === "handoff_failed" && (e.reason === "bounced" || e.reason === "late")) failed.add(`${e.taskId}|${e.workerId}`);
        if (e.kind === "handoff_accepted") expect(failed.has(`${e.taskId}|${e.workerId}`)).toBe(false);
      }
    }
  });
});

describe.each(DISPATCHERS)("sim invariants tick by tick (%s)", (_name, dispatcher) => {
  it("no worker is on two tasks, and off-shift or stranded workers hold no task", () => {
    for (const seed of [1, 2]) {
      const sim = createSim({ seed, dispatcher });
      for (let i = 0; i < 2 * DAY; i++) {
        stepSim(sim);
        const ids = sim.tasks.flatMap((t) => (t.workerId ? [t.workerId] : []));
        expect(new Set(ids).size).toBe(ids.length);
        for (const w of sim.workers) {
          if (w.status === "off_shift" || w.status === "stranded") expect(ids).not.toContain(w.id);
        }
      }
    }
  });

  it("at most one open escalation per task", () => {
    const sim = createSim({ seed: 3, dispatcher });
    for (let i = 0; i < 2 * DAY; i++) {
      stepSim(sim);
      const open = sim.escalations.filter((e) => e.status === "open").flatMap((e) => e.taskIds);
      expect(new Set(open).size).toBe(open.length);
    }
  });
});

describe("sim: dispatcher contract", () => {
  const run = (dispatcher: Dispatcher) => () => runSim({ seed: "arien-demo", ticks: 2000, dispatcher });
  const naiveAssigns = (ctx: Parameters<Dispatcher>[0]) => naiveDispatcher(ctx).filter((d) => d.kind === "assign");

  it("rejects an assignment to a worker that does not exist", () => {
    expect(run((ctx) => naiveAssigns(ctx).map((d) => ({ ...d, workerId: "X" })))).toThrow(/No worker X/);
  });

  it("rejects an assignment to a worker without the skill", () => {
    expect(run((ctx) => naiveAssigns(ctx).map((d) => ({ ...d, workerId: "G1" })))).toThrow(/cannot do/);
  });

  it("rejects a decision with no why", () => {
    expect(run((ctx) => naiveAssigns(ctx).map((d) => ({ ...d, why: "" })))).toThrow(/no why/);
  });

  it("rejects giving one worker two tasks, or one task two workers", () => {
    expect(run((ctx) => naiveAssigns(ctx).flatMap((d) => [d, { ...d }]))).toThrow();
  });

  it("rejects duplicate worker ids", () => {
    expect(() => createSim({ seed: 1, crew: [createDrone("A"), createTechnician("A")] })).toThrow(/unique/);
  });
});
