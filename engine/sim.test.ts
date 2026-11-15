import { describe, expect, it } from "vitest";
import { runFaultLog } from "./faults";
import { createSim, firstFreeDispatcher, formatEvent, runSim, stepSim, type Dispatcher, type Sim, type SimEvent } from "./sim";
import { NEXT_STATES } from "./tasks";
import { createDrone, createGroundRobot, createTechnician } from "./workers";

const log = (sim: Sim) => sim.events.map((e) => formatEvent(e, sim)).join("\n");
const stateEvents = (sim: Sim, taskId: string) =>
  sim.events.filter((e): e is Extract<SimEvent, { kind: "state" }> => e.kind === "state" && e.taskId === taskId);

describe("sim: determinism", () => {
  it("same seed gives a byte-identical 1,000-tick event log", () => {
    const a = runSim({ seed: "arien-demo", ticks: 1000 });
    const b = runSim({ seed: "arien-demo", ticks: 1000 });
    expect(a.events.length).toBeGreaterThan(50);
    expect(log(a)).toBe(log(b));
    expect(a.tasks).toEqual(b.tasks);
    expect(a.workers).toEqual(b.workers);
  });

  it("different seeds give different logs", () => {
    expect(log(runSim({ seed: 1, ticks: 1000 }))).not.toBe(log(runSim({ seed: 2, ticks: 1000 })));
  });

  it("holds across many seeds", () => {
    for (let seed = 0; seed < 20; seed++) {
      expect(log(runSim({ seed, ticks: 800 }))).toBe(log(runSim({ seed, ticks: 800 })));
    }
  });

  it("stepping one tick at a time matches runSim", () => {
    const sim = createSim({ seed: 9 });
    for (let i = 0; i < 1000; i++) stepSim(sim);
    expect(log(sim)).toBe(log(runSim({ seed: 9, ticks: 1000 })));
  });
});

describe("sim: faults and outcomes do not depend on the dispatcher", () => {
  const idle: Dispatcher = () => [];

  it("tasks match the fault log exactly", () => {
    const sim = runSim({ seed: 42, ticks: 1000 });
    expect(sim.tasks.map((t) => t.fault)).toEqual(runFaultLog({ seed: 42, ticks: 1000 }));
  });

  it("a dispatcher that does nothing sees the same faults and replace decisions", () => {
    const busy = runSim({ seed: 42, ticks: 1000 });
    const lazy = runSim({ seed: 42, ticks: 1000, dispatcher: idle });
    expect(lazy.tasks.map((t) => [t.fault, t.needsReplace])).toEqual(busy.tasks.map((t) => [t.fault, t.needsReplace]));
    expect(lazy.tasks.every((t) => t.state === "detected")).toBe(true);
  });
});

describe("sim: lifecycle rules hold for every task", () => {
  const sims = [1, 2, 3, "arien-demo"].map((seed) =>
    runSim({ seed, ticks: 3000, crew: [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1"), createTechnician("T2")] }),
  );

  it("every state change is a legal move, in order, starting from detected", () => {
    for (const sim of sims) {
      for (const task of sim.tasks) {
        let state = "detected" as keyof typeof NEXT_STATES;
        for (const e of stateEvents(sim, task.id)) {
          expect(e.from).toBe(state);
          expect(NEXT_STATES[state]).toContain(e.to);
          state = e.to;
        }
        expect(task.state).toBe(state);
      }
    }
  });

  it("done tasks went inspect -> verify -> repair or replace -> done", () => {
    let done = 0;
    let replaced = 0;
    for (const sim of sims) {
      for (const task of sim.tasks.filter((t) => t.state === "done")) {
        done += 1;
        const path = stateEvents(sim, task.id).map((e) => e.to);
        const fix = task.needsReplace ? "replace" : "repair";
        if (task.needsReplace) replaced += 1;
        expect(path).toEqual(["inspect", "verify", fix, "done"]);
        expect(task.doneTick).toBeGreaterThan(task.createdTick);
      }
    }
    expect(done).toBeGreaterThan(10);
    expect(replaced).toBeGreaterThan(0); // the replace branch really happens
  });

  it("each step is done by a worker with the right skill", () => {
    for (const sim of sims) {
      const skills = new Map(sim.workers.map((w) => [w.id, w.skills]));
      for (const e of sim.events) {
        if (e.kind !== "state" || e.from === "detected") continue;
        expect(skills.get(e.workerId!)).toContain(e.from);
      }
    }
  });

  it("no worker is ever on two tasks at once", () => {
    for (const seed of [1, 2, 3]) {
      const sim = createSim({ seed });
      for (let i = 0; i < 2000; i++) {
        stepSim(sim);
        const ids = sim.tasks.flatMap((t) => (t.workerId ? [t.workerId] : []));
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it("every assignment carries a why", () => {
    for (const sim of sims) {
      const assigned = sim.events.filter((e) => e.kind === "assigned");
      expect(assigned.length).toBeGreaterThan(0);
      for (const e of assigned) expect(e.why.length).toBeGreaterThan(0);
    }
  });
});

describe("sim: first-free dispatcher", () => {
  it("picks the first free worker in crew order that has the skill", () => {
    const sim = runSim({ seed: "arien-demo", ticks: 100, crew: [createTechnician("T1"), createGroundRobot("G1"), createDrone("D1")] });
    const firstVerify = sim.events.find((e) => e.kind === "assigned" && sim.tasks.find((t) => t.id === e.taskId) && e.why.includes("verify"));
    expect(firstVerify).toBeDefined();
    // Night time: T1 is off shift, so G1 gets verify even though T1 is listed first.
    expect(firstVerify && "workerId" in firstVerify && firstVerify.workerId).toBe("G1");
  });

  it("never assigns an off-shift technician", () => {
    const sim = runSim({ seed: 3, ticks: 1000 });
    for (const e of sim.events) {
      if (e.kind !== "assigned" || e.workerId !== "T1") continue;
      const hour = ((e.tick * sim.clock.tickSeconds) / 3600) % 24;
      expect(hour).toBeGreaterThanOrEqual(8);
      expect(hour).toBeLessThan(16);
    }
  });

  it("releases a task when the technician's shift ends, and it gets picked up later", () => {
    // 2 days, so a repair in progress at 16:00 gets dropped and resumed the next morning.
    const sim = runSim({ seed: 3, ticks: 2 * 1440, crew: [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1")] });
    const released = sim.events.filter((e) => e.kind === "released" && e.why === "shift ended");
    expect(released.length).toBeGreaterThan(0);
    const first = released[0];
    const reassigned = sim.events.find((e) => e.kind === "assigned" && e.taskId === first.taskId && e.tick > first.tick);
    expect(reassigned).toBeDefined();
  });

  it("releases a task when the drone's battery dies (no battery check in the naive rule)", () => {
    const sim = runSim({ seed: "arien-demo", ticks: 1000 });
    expect(sim.events.some((e) => e.kind === "released" && e.why === "battery died")).toBe(true);
    expect(sim.workers.find((w) => w.id === "D1")!.status).toBe("stranded");
  });

  it("returns nothing when nobody has the skill", () => {
    const sim = runSim({ seed: 1, ticks: 500, crew: [createGroundRobot("G1")] });
    expect(sim.tasks.every((t) => t.state === "detected")).toBe(true);
    expect(sim.events.every((e) => e.kind === "detected")).toBe(true);
  });
});

describe("sim: dispatcher contract", () => {
  it("rejects assignments that break the rules", () => {
    const run = (dispatcher: Dispatcher) => () => runSim({ seed: "arien-demo", ticks: 50, dispatcher });
    const firstTask: Dispatcher = (ctx) => (ctx.tasks[0] && ctx.tasks[0].workerId === null ? [{ taskId: ctx.tasks[0].id, workerId: "X", why: "x" }] : []);
    expect(run(firstTask)).toThrow(/Bad assignment/);
    const wrongSkill: Dispatcher = (ctx) => (ctx.tasks[0]?.state === "detected" ? [{ taskId: ctx.tasks[0].id, workerId: "G1", why: "x" }] : []);
    expect(run(wrongSkill)).toThrow(/cannot do/);
    const noWhy: Dispatcher = (ctx) => firstFreeDispatcher(ctx).map((a) => ({ ...a, why: "" }));
    expect(run(noWhy)).toThrow(/no why/);
    const double: Dispatcher = (ctx) => {
      const a = firstFreeDispatcher(ctx);
      return a.length ? [a[0], { ...a[0] }] : [];
    };
    expect(run(double)).toThrow();
  });

  it("rejects duplicate worker ids", () => {
    expect(() => createSim({ seed: 1, crew: [createDrone("A"), createTechnician("A")] })).toThrow(/unique/);
  });
});
