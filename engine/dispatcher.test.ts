// Tests for docs/dispatcher-spec.md: scoring, worker choice, handoffs, each failure
// case, escalation, the why log, and the naive baseline.
import { describe, expect, it } from "vitest";
import { advance, createClock } from "./clock";
import { DEFAULT_COORDINATION_CONFIG, RULES, formatDecision, type DispatchDecision, type Dispatcher, type WhyRecord } from "./decisions";
import { arienDispatcher, naiveDispatcher, scoreTask } from "./dispatcher";
import type { Fault, FaultType, Severity } from "./faults";
import { applyHumanAction, createSim, injectFault, runSim, stepSim, type Sim, type SimEvent, type SimOptions } from "./sim";
import { DEFAULT_TASK_CONFIG, createTask, type EscalatedState, type FaultOutcomes, type Task } from "./tasks";
import { createDrone, createGroundRobot, createTechnician, type Worker } from "./workers";

// ---------- helpers ----------

const NO_FAULTS = { perTickChance: { hotspot: 0, soiling: 0, string_outage: 0, tracker_stuck: 0 } };
const TICKS_PER_HOUR = 360; // 10-second ticks
const MIN = 6; // ticks per minute

/** A quiet sim (no random faults) starting at a given hour. Faults are placed by hand. */
function quietSim(hour: number, options: Partial<SimOptions> = {}): Sim {
  return createSim({ seed: 1, faultConfig: NO_FAULTS, clock: advance(createClock(), Math.round(hour * TICKS_PER_HOUR)), ...options });
}

let faultSeq = 0;
interface Place {
  type?: FaultType;
  severity?: Severity;
  row?: number;
  col?: number;
}
/** Places a one-panel fault that appears on the next tick. */
function place(sim: Sim, { type = "hotspot", severity = 3, row = 5, col = 10 }: Place = {}, outcomes: Partial<FaultOutcomes> = {}): string {
  faultSeq += 1;
  const fault: Fault = {
    id: `F${9000 + faultSeq}`,
    type,
    severity,
    startTick: sim.clock.tick + 1,
    location: { row, colStart: col, colEnd: col, x: col * sim.site.panelSpacingM, y: row * sim.site.rowPitchM },
  };
  return injectFault(sim, fault, outcomes).id;
}

const run = (sim: Sim, ticks: number) => {
  for (let i = 0; i < ticks; i++) stepSim(sim);
};
/** Steps until the condition holds. Fails the test if it never does. */
function until(sim: Sim, condition: () => boolean, maxTicks = 20_000): void {
  for (let i = 0; i < maxTicks; i++) {
    if (condition()) return;
    stepSim(sim);
  }
  throw new Error("Condition never became true");
}

const task = (sim: Sim, id: string): Task => sim.tasks.find((t) => t.id === id)!;
const worker = (sim: Sim, id: string): Worker => sim.workers.find((w) => w.id === id)!;
const whys = (sim: Sim, taskId: string, kind?: WhyRecord["kind"]) => sim.decisions.filter((d) => d.taskId === taskId && (!kind || d.kind === kind));
const events = <K extends SimEvent["kind"]>(sim: Sim, kind: K, taskId?: string) =>
  sim.events.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === kind && (!taskId || e.taskId === taskId));
const lastAssign = (sim: Sim, taskId: string) => whys(sim, taskId, "assign").at(-1)!;
const setWorker = (sim: Sim, id: string, patch: Partial<Worker>) => {
  sim.workers = sim.workers.map((w) => (w.id === id ? { ...w, ...patch } : w));
};

const FAR = { row: 19, col: 39 }; // the far corner, about 122 m from home

// ---------- 1. scoring ----------

describe("task scoring", () => {
  const coord = DEFAULT_COORDINATION_CONFIG;
  const make = (type: FaultType, severity: Severity, startTick = 0) =>
    createTask({ id: "F0001", type, severity, startTick, location: { row: 0, colStart: 0, colEnd: 0, x: 0, y: 0 } });
  const atTick = (tick: number) => ({ tick, tickSeconds: 10 });

  it("is 20 x severity + wait + type bonus + interrupted bonus, and the parts add up", () => {
    const score = scoreTask({ ...make("string_outage", 4), interrupted: true }, atTick(30 * MIN), coord);
    expect(score).toEqual({ total: 80 + 5 + 10 + 20, severity: 80, wait: 5, type: 10, interrupted: 20 });
  });

  it("adds 10 points per hour waited, counted from detection", () => {
    expect(scoreTask(make("soiling", 1), atTick(0), coord).wait).toBe(0);
    expect(scoreTask(make("soiling", 1), atTick(TICKS_PER_HOUR), coord).wait).toBe(10);
    expect(scoreTask(make("soiling", 1, 100), atTick(100 + 3 * TICKS_PER_HOUR), coord).wait).toBe(30);
  });

  it("caps the wait points, so an old sev-1 never beats a fresh sev-5", () => {
    const old = scoreTask(make("tracker_stuck", 1), atTick(48 * TICKS_PER_HOUR), coord);
    expect(old.wait).toBe(60);
    expect(old.total).toBe(95);
    expect(scoreTask(make("soiling", 5), atTick(0), coord).total).toBe(100);
  });

  it("gives faults that take out more panels a small bonus", () => {
    const total = (type: FaultType) => scoreTask(make(type, 3), atTick(0), coord).total;
    expect([total("tracker_stuck"), total("string_outage"), total("hotspot"), total("soiling")]).toEqual([75, 70, 65, 60]);
  });

  it("serves the highest score first", () => {
    const sim = quietSim(10);
    const low = place(sim, { severity: 1 });
    run(sim, 1); // the drone takes the only task
    const mid = place(sim, { severity: 3 });
    const high = place(sim, { severity: 5 });
    until(sim, () => task(sim, mid).state !== "detected" && task(sim, high).state !== "detected");
    const order = events(sim, "handoff_accepted").filter((e) => e.handoff === "pickup").map((e) => e.taskId);
    expect(order).toEqual([low, high, mid]);
  });

  it("breaks exact ties by age, then id", () => {
    const sim = quietSim(10);
    place(sim, { severity: 2 });
    run(sim, 1);
    const a = place(sim, { severity: 3, row: 2, col: 2 });
    const b = place(sim, { severity: 3, row: 2, col: 2 }); // same score, same spot, later id
    until(sim, () => task(sim, b).state !== "detected");
    const order = events(sim, "handoff_accepted").filter((e) => e.handoff === "pickup").map((e) => e.taskId);
    expect(order.slice(1)).toEqual([a, b]);
  });
});

// ---------- 2. worker choice ----------

describe("worker choice", () => {
  it("specialist first: the robot verifies even when a technician is closer", () => {
    const sim = quietSim(10, { crew: [createDrone("D1"), createTechnician("T1", { position: { x: 11, y: 30 } }), createGroundRobot("G1")] });
    const id = place(sim);
    until(sim, () => task(sim, id).state === "verify" && task(sim, id).workerId !== null);
    expect(task(sim, id).workerId).toBe("G1");
    expect(lastAssign(sim, id).why).toMatch(/G1 chosen: specialist first \(1 skills vs T1's 4\)/);
    expect(lastAssign(sim, id).rule).toBe("ASSIGN_SPECIALIST_NEAREST");
  });

  it("then earliest arrival: the closer of two robots goes", () => {
    const sim = quietSim(10, { crew: [createDrone("D1"), createGroundRobot("G1"), createGroundRobot("G2", { home: { x: 40, y: 100 } }), createTechnician("T1")] });
    const id = place(sim, FAR);
    until(sim, () => task(sim, id).state === "verify" && task(sim, id).workerId !== null);
    expect(task(sim, id).workerId).toBe("G2");
    expect(lastAssign(sim, id).why).toMatch(/G2 chosen: closest/);
  });

  it("battery left: a drone that cannot make the round trip with reserve is held back", () => {
    // 25 min battery. Charge left: 6 min. A hotspot inspect needs 5 min + travel + 5 min reserve.
    const drone = createDrone("D1");
    const sim = quietSim(10, { crew: [{ ...drone, battery: { ...drone.battery!, chargeS: 6 * 60 } }, createGroundRobot("G1"), createTechnician("T1")] });
    const id = place(sim);
    run(sim, 2);
    expect(task(sim, id).workerId).toBeNull();
    const hold = whys(sim, id, "hold")[0];
    expect(hold.rule).toBe("HOLD_BATTERY");
    expect(hold.why).toMatch(/D1: needs about \d+ more min of charge/);
    // Once it has charged enough, it goes.
    until(sim, () => task(sim, id).workerId === "D1");
    expect(events(sim, "stranded")).toHaveLength(0);
  });

  it("shift left: a technician is not given a job that cannot finish before the shift ends", () => {
    const sim = quietSim(15, { autoHuman: false }); // inspect + verify take about 17 min, so repair is offered around 15:17
    const id = place(sim, { severity: 2 }); // 45 min repair, 43 min of shift left
    until(sim, () => task(sim, id).state === "repair" || task(sim, id).state === "replace");
    run(sim, 2);
    expect(task(sim, id).workerId).toBeNull();
    const hold = whys(sim, id, "hold").at(-1)!;
    expect(hold.rule).toBe("HOLD_SHIFT_TOO_SHORT");
    expect(hold.why).toMatch(/T1: shift ends in \d+ min, job needs \d+ min/);
    until(sim, () => worker(sim, "T1").status === "off_shift");
    expect(events(sim, "released")).toHaveLength(0); // nothing was started, so nothing was dropped
  });

  // The guard is easiest to see by calling the dispatcher directly on a hand-built moment.
  describe("technician guard", () => {
    const crew = () => [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1")];
    const taskIn = (id: string, state: Task["state"], severity: Severity, extra: Partial<Task> = {}): Task => ({
      ...createTask({ id: `F${id}`, type: "hotspot", severity, startTick: 0, location: { row: 2, colStart: 2, colEnd: 2, x: 2.2, y: 12 } }),
      state,
      ...extra,
    });
    const decide = (hour: number, tasks: Task[]) =>
      arienDispatcher({
        clock: advance(createClock(), Math.round(hour * TICKS_PER_HOUR)),
        tasks,
        workers: crew(),
        busy: new Set(tasks.flatMap((t) => (t.workerId ? [t.workerId] : []))),
        coord: DEFAULT_COORDINATION_CONFIG,
        taskConfig: DEFAULT_TASK_CONFIG,
      });
    const robotBusy = taskIn("0001", "verify", 2, { workerId: "G1", phase: "working" });
    const urgentVerify = taskIn("0002", "verify", 5);
    const smallRepair = taskIn("0003", "repair", 1);

    it("a technician does not verify while a repair job is waiting for them", () => {
      const decisions = decide(10, [robotBusy, urgentVerify, smallRepair]);
      const hold = decisions.find((d) => d.kind === "hold" && d.taskId === "T0002")!;
      expect(hold.why).toContain("G1: busy on T0001; T1: held for repair job T0003");
      expect(hold.kind === "hold" && hold.considered!.find((c) => c.workerId === "T1")!.rejectKind).toBe("guard");
      expect(decisions.find((d) => d.kind === "assign")).toMatchObject({ taskId: "T0003", workerId: "T1" });
    });

    it("with no repair waiting, a free technician does verify", () => {
      const decisions = decide(10, [robotBusy, urgentVerify]);
      expect(decisions.find((d) => d.kind === "assign")).toMatchObject({ taskId: "T0002", workerId: "T1" });
    });

    it("the guard is off when the robot has already failed the task", () => {
      const bounced = { ...urgentVerify, failedWorkerIds: ["G1"] };
      const decisions = decide(10, [bounced, smallRepair]);
      expect(decisions.find((d) => d.kind === "assign")).toMatchObject({ taskId: "T0002", workerId: "T1" });
      expect(decisions.find((d) => d.kind === "hold")).toMatchObject({ taskId: "T0003", rule: "HOLD_BUSY" });
    });

    it("the guard ignores repair jobs the technician could not finish this shift", () => {
      const decisions = decide(15.5, [robotBusy, urgentVerify, smallRepair]); // 30 min left, repair needs 45
      expect(decisions.find((d) => d.kind === "assign")).toMatchObject({ taskId: "T0002", workerId: "T1" });
      expect(decisions.some((d) => d.kind === "assign" && d.taskId === "T0003")).toBe(false);
    });
  });

  it("no preemption: a worker keeps their job when a more severe fault appears", () => {
    const sim = quietSim(10);
    const first = place(sim, { severity: 1, ...FAR });
    until(sim, () => task(sim, first).workerId === "D1");
    const urgent = place(sim, { severity: 5, row: 0, col: 1 });
    run(sim, 3);
    expect(task(sim, first).workerId).toBe("D1");
    expect(task(sim, urgent).workerId).toBeNull();
    expect(whys(sim, urgent, "hold")[0]).toMatchObject({ rule: "HOLD_BUSY" });
    expect(whys(sim, urgent, "hold")[0].why).toContain(`D1: busy on ${first}`);
  });

  it("near-tie: within 10 points, the worker takes the closer task", () => {
    const sim = quietSim(10);
    const busy = place(sim, { severity: 1 });
    until(sim, () => task(sim, busy).workerId === "D1");
    const farHigher = place(sim, { severity: 3, type: "string_outage", ...FAR }); // 70 points
    const nearLower = place(sim, { severity: 3, type: "hotspot", row: 0, col: 2 }); // 65 points
    until(sim, () => task(sim, nearLower).workerId !== null || task(sim, farHigher).workerId !== null);
    expect(task(sim, nearLower).workerId).toBe("D1");
    expect(lastAssign(sim, nearLower).rule).toBe("ASSIGN_NEAR_TIE_CLOSER");
    expect(lastAssign(sim, nearLower).why).toContain(`within 10 points of ${farHigher}`);
  });

  it("near-tie does not apply beyond 10 points", () => {
    const sim = quietSim(10);
    const busy = place(sim, { severity: 1 });
    until(sim, () => task(sim, busy).workerId === "D1");
    const farHigher = place(sim, { severity: 4, ...FAR });
    const nearLower = place(sim, { severity: 3, row: 0, col: 2 });
    until(sim, () => task(sim, nearLower).workerId !== null || task(sim, farHigher).workerId !== null);
    expect(task(sim, farHigher).workerId).toBe("D1");
  });
});

// ---------- 3. handoffs ----------

describe("handoffs", () => {
  it("a clean task goes pickup -> confirm -> fix, each offered, accepted, completed", () => {
    const sim = quietSim(10);
    const id = place(sim, {}, { needsReplace: false });
    until(sim, () => task(sim, id).state === "done");
    const trail = sim.events
      .filter((e) => e.taskId === id && e.kind.startsWith("handoff_"))
      .map((e) => `${"handoff" in e ? e.handoff : ""} ${e.kind.slice(8)}${"workerId" in e && e.workerId ? ` ${e.workerId}` : ""}`);
    expect(trail).toEqual([
      "pickup offered",
      "pickup accepted D1",
      "pickup completed D1",
      "confirm offered",
      "confirm accepted G1",
      "confirm completed G1",
      "fix offered",
      "fix accepted T1",
      "fix completed T1",
    ]);
    expect(events(sim, "handoff_failed")).toHaveLength(0);
    expect(task(sim, id)).toMatchObject({ resolution: "repaired", handoff: null });
  });

  it("the accept deadline depends on severity: 15 min for sev 5 down to 4 h for sev 1", () => {
    const sim = quietSim(10);
    const windows = ([5, 4, 3, 2, 1] as Severity[]).map((severity) => {
      const h = task(sim, place(sim, { severity })).handoff!;
      return h.deadlineTick - h.offeredTick;
    });
    expect(windows).toEqual([15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN]);
  });

  it("an accepted handoff must arrive within travel time plus 5 minutes", () => {
    const sim = quietSim(10);
    const id = place(sim, FAR);
    until(sim, () => task(sim, id).workerId === "D1");
    const accepted = events(sim, "handoff_accepted", id)[0];
    const travelTicks = Math.ceil(Math.hypot(39 * 1.1, 19 * 6) / 5 / 10);
    expect(accepted.arriveByTick).toBe(accepted.tick + travelTicks + 5 * MIN);
  });
});

// ---------- 4. failure cases ----------

describe("failure case a: drone battery dies mid-flight", () => {
  // A drone with 10 seconds of battery, under the naive dispatcher (Arien would not send it).
  const weakDrone = () => createDrone("D1", { battery: { capacityS: 10, rechargeS: 600 } });
  const setup = (dispatcher: Dispatcher) => {
    const sim = quietSim(10, { dispatcher, crew: [weakDrone(), createGroundRobot("G1"), createTechnician("T1")], autoHuman: false });
    const id = place(sim, FAR);
    return { sim, id };
  };

  it("the handoff is dropped and the task goes back in the queue with +20", () => {
    const { sim, id } = setup(naiveDispatcher);
    until(sim, () => worker(sim, "D1").status === "stranded");
    expect(events(sim, "handoff_failed", id)[0]).toMatchObject({ reason: "dropped", workerId: "D1", handoff: "pickup" });
    expect(events(sim, "released", id)[0]).toMatchObject({ workerId: "D1", cause: "battery died" });
    expect(task(sim, id)).toMatchObject({ state: "inspect", phase: "waiting", workerId: null, interrupted: true });
    expect(scoreTask(task(sim, id), sim.clock, sim.coord).interrupted).toBe(20);
    expect(whys(sim, id, "retry")[0]).toMatchObject({ rule: "RETRY_AFTER_DROP", workerId: "D1" });
    expect(whys(sim, id, "retry")[0].why).toMatch(/D1's battery died on the way to inspect/);
  });

  it("a recovery job is created and it escalates right away as urgent", () => {
    const { sim } = setup(naiveDispatcher);
    until(sim, () => worker(sim, "D1").status === "stranded");
    const job = sim.tasks.find((t) => t.kind === "recover")!;
    expect(job).toMatchObject({ id: "R0001", recoverWorkerId: "D1", state: "repair" });
    expect(job.target).toEqual(worker(sim, "D1").position);
    const esc = sim.escalations[0];
    expect(esc).toMatchObject({ level: "urgent", rule: "ESCALATE_STRANDED", workerId: "D1", status: "open", taskIds: ["R0001"] });
    expect(esc.headline).toBe("D1 is stranded with a dead battery");
    expect(esc.openedTick).toBe(events(sim, "stranded")[0].tick);
  });

  it("a technician fetches the drone: it ends up home, empty, charging", () => {
    const { sim } = setup(naiveDispatcher);
    until(sim, () => events(sim, "recovered").length > 0);
    expect(events(sim, "handoff_accepted", "R0001")[0]).toMatchObject({ workerId: "T1", handoff: "recover" });
    const drone = worker(sim, "D1");
    expect(drone.position).toEqual(drone.home);
    expect(drone.status).toBe("charging");
    expect(task(sim, "R0001")).toMatchObject({ state: "done", resolution: "recovered" });
    // It took technician time: 10 minutes on site.
    const done = events(sim, "state", "R0001").at(-1)!;
    expect(done.tick - events(sim, "handoff_completed", "R0001")[0].tick).toBe(10 * MIN);
  });

  it("the same thing happens under Arien if the battery dies anyway (dies while working)", () => {
    // Enough charge to pass Arien's check on paper is impossible here, so force the trip by hand.
    const sim = quietSim(10, { autoHuman: false });
    const id = place(sim);
    until(sim, () => task(sim, id).phase === "working" && task(sim, id).workerId === "D1");
    setWorker(sim, "D1", { battery: { ...worker(sim, "D1").battery!, chargeS: 20 } });
    until(sim, () => worker(sim, "D1").status === "stranded");
    expect(whys(sim, id, "release")[0]).toMatchObject({ rule: "RELEASE_BATTERY_DIED", workerId: "D1" });
    expect(whys(sim, id, "release")[0].why).toMatch(/Progress on this step is lost/);
    expect(task(sim, id)).toMatchObject({ state: "inspect", interrupted: true, workerId: null });
    expect(sim.escalations.some((e) => e.rule === "ESCALATE_STRANDED")).toBe(true);
    // Recovered, recharged, and the same drone finishes the inspection.
    until(sim, () => task(sim, id).state === "verify");
    expect(events(sim, "recovered")).toHaveLength(1);
  });

  it("Arien's battery check means it never strands a drone on its own decisions", () => {
    for (const seed of [1, 2, 3, "arien-demo"]) {
      const sim = runSim({ seed, ticks: 2 * 8640 });
      expect(events(sim, "stranded")).toHaveLength(0);
      expect(sim.decisions.some((d) => d.rule === "RELEASE_BATTERY_DIED")).toBe(false);
    }
  });
});

describe("failure case b: robot can't confirm a fault", () => {
  it("the handoff bounces, the robot is not offered it again, a technician verifies", () => {
    const sim = quietSim(10);
    const id = place(sim, {}, { robotCanConfirm: false, needsReplace: false });
    until(sim, () => task(sim, id).failedWorkerIds.includes("G1"));
    expect(events(sim, "handoff_failed", id)[0]).toMatchObject({ reason: "bounced", workerId: "G1", handoff: "confirm" });
    expect(task(sim, id)).toMatchObject({ state: "verify", workerId: null });
    expect(whys(sim, id, "retry")[0]).toMatchObject({ rule: "RETRY_AFTER_BOUNCE" });
    expect(whys(sim, id, "retry")[0].why).toMatch(/G1 could not confirm the fault/);

    until(sim, () => task(sim, id).workerId !== null);
    expect(task(sim, id).workerId).toBe("T1");
    expect(lastAssign(sim, id).why).toContain("Skipped G1: already failed this step");
    until(sim, () => task(sim, id).state === "done");
    expect(task(sim, id).resolution).toBe("repaired");
    expect(events(sim, "handoff_failed", id)).toHaveLength(1);
  });

  it("a false alarm closes the task when the technician checks", () => {
    const sim = quietSim(10);
    const id = place(sim, {}, { robotCanConfirm: false, falseAlarm: true });
    until(sim, () => task(sim, id).state === "done");
    expect(task(sim, id).resolution).toBe("false_alarm");
    expect(events(sim, "state", id).map((e) => `${e.from}->${e.to}`)).toEqual(["detected->inspect", "inspect->verify", "verify->done"]);
  });

  it("a robot never closes a false alarm by itself, and a confirmable fault never bounces", () => {
    const sim = quietSim(10);
    const fine = place(sim, {}, { robotCanConfirm: true, falseAlarm: true });
    until(sim, () => task(sim, fine).state === "done");
    expect(task(sim, fine).resolution).not.toBe("false_alarm");
    expect(events(sim, "handoff_failed", fine)).toHaveLength(0);
  });

  it("at night it waits for a technician, and escalates only when the deadline passes", () => {
    const sim = quietSim(1, { autoHuman: false });
    const id = place(sim, { severity: 4 }, { robotCanConfirm: false }); // 30 min to accept
    until(sim, () => task(sim, id).failedWorkerIds.includes("G1"));
    const bouncedAt = sim.clock.tick;
    run(sim, 2);
    expect(whys(sim, id, "hold").at(-1)!.why).toContain("G1: already failed this step; T1: off shift until 08:00");
    expect(sim.escalations).toHaveLength(0);
    until(sim, () => sim.escalations.length > 0);
    expect(sim.clock.tick).toBe(bouncedAt + 30 * MIN + 1);
    expect(sim.escalations[0]).toMatchObject({ rule: "ESCALATE_NO_WORKER_ON_SHIFT", taskIds: [id] });
  });

  it("the naive baseline also cannot send the robot back to the same task", () => {
    const sim = quietSim(10, { dispatcher: naiveDispatcher });
    const id = place(sim, {}, { robotCanConfirm: false });
    until(sim, () => task(sim, id).state !== "verify" && task(sim, id).state !== "inspect" && task(sim, id).state !== "detected");
    const verifiers = events(sim, "handoff_accepted", id).filter((e) => e.handoff === "confirm").map((e) => e.workerId);
    expect(verifiers).toEqual(["G1", "T1"]);
  });
});

describe("failure case c: no technician on shift", () => {
  it("the task waits, with one hold logged, not one per tick", () => {
    const sim = quietSim(1, { autoHuman: false });
    const id = place(sim, { severity: 1 }, { needsReplace: false });
    until(sim, () => task(sim, id).state === "repair");
    run(sim, 30 * MIN);
    const holds = whys(sim, id, "hold").filter((d) => d.rule === "HOLD_OFF_SHIFT");
    expect(holds).toHaveLength(1);
    expect(holds[0].why).toContain("Nobody can repair yet. T1: off shift until 08:00.");
    expect(sim.escalations).toHaveLength(0);
  });

  it("no escalation when the next shift starts before the deadline", () => {
    const sim = quietSim(7.5); // sev 3: 60 min to accept, shift starts in 30 min
    const id = place(sim, { severity: 3 });
    until(sim, () => task(sim, id).workerId === "T1");
    expect(sim.clock.tick).toBe(8 * TICKS_PER_HOUR);
    expect(sim.escalations).toHaveLength(0);
    expect(events(sim, "handoff_failed", id)).toHaveLength(0);
  });

  it("escalates when the deadline passes first, suggesting to wait for the shift", () => {
    const sim = quietSim(1, { autoHuman: false });
    const id = place(sim, { severity: 4 }, { needsReplace: false });
    until(sim, () => task(sim, id).state === "repair");
    const offered = task(sim, id).handoff!.offeredTick;
    until(sim, () => sim.escalations.length > 0);
    expect(sim.clock.tick).toBe(offered + 30 * MIN + 1);
    const esc = sim.escalations[0];
    expect(esc).toMatchObject({ level: "needs_decision", rule: "ESCALATE_NO_WORKER_ON_SHIFT", status: "open" });
    expect(esc.suggested).toEqual({ action: "wait", untilTick: 8 * TICKS_PER_HOUR, label: "Wait for T1, shift starts 08:00" });
    expect(esc.headline).toMatch(/^Sev 4 hotspot at R06-P11 has waited \d+ min for repair, nobody is on shift$/);
    expect(events(sim, "handoff_failed", id)[0]).toMatchObject({ reason: "timed_out", handoff: "fix" });
  });

  it("several stuck tasks share one digest, not one escalation each", () => {
    const sim = quietSim(1, { autoHuman: false });
    const ids = [place(sim, { severity: 4 }), place(sim, { severity: 4, row: 8 }), place(sim, { severity: 4, row: 12 })];
    until(sim, () => ids.every((id) => task(sim, id).escalationId !== null), 3000);
    expect(sim.escalations).toHaveLength(1);
    expect(sim.escalations[0].taskIds.sort()).toEqual([...ids].sort());
    expect(sim.escalations[0].headline).toMatch(/^3 tasks/);
  });

  it("after the human says wait, the technician picks it up at shift start with no second escalation", () => {
    const sim = quietSim(1); // auto-human on
    const id = place(sim, { severity: 4 }, { needsReplace: false });
    until(sim, () => task(sim, id).workerId === "T1");
    expect(sim.clock.tick).toBe(8 * TICKS_PER_HOUR);
    const forTask = sim.escalations.filter((e) => e.taskIds.includes(id) && e.level !== "notice");
    expect(forTask).toHaveLength(1);
    expect(forTask[0]).toMatchObject({ status: "resolved", resolvedBy: "auto-human", resolution: "Wait for T1, shift starts 08:00" });
  });
});

describe("failure case d: handoff times out", () => {
  // One drone with a huge battery and a 40-minute inspection, so a second fault has to wait.
  const slowInspect = { workSeconds: { ...DEFAULT_TASK_CONFIG.workSeconds, inspect: { ...DEFAULT_TASK_CONFIG.workSeconds.inspect, hotspot: 40 * 60 } } };
  const bigDrone = () => createDrone("D1", { battery: { capacityS: 8 * 3600, rechargeS: 3600 } });
  const setup = (options: Partial<SimOptions> = {}) => {
    const sim = quietSim(10, { crew: [bigDrone(), createGroundRobot("G1"), createTechnician("T1")], taskConfig: slowInspect, ...options });
    const first = place(sim, { severity: 5 });
    run(sim, 1);
    const second = place(sim, { severity: 5, row: 9 });
    return { sim, first, second };
  };

  it("times out when nobody accepts by the deadline, and escalates", () => {
    const { sim, first, second } = setup({ autoHuman: false });
    const offered = task(sim, second).handoff!.offeredTick;
    until(sim, () => events(sim, "handoff_failed", second).length > 0);
    expect(sim.clock.tick).toBe(offered + 15 * MIN + 1);
    expect(events(sim, "handoff_failed", second)[0]).toMatchObject({ reason: "timed_out", handoff: "pickup", workerId: null });
    expect(whys(sim, second, "handoff")[0]).toMatchObject({ rule: "HANDOFF_TIMED_OUT" });
    const esc = sim.escalations.find((e) => e.taskIds.includes(second) && e.level !== "notice")!;
    expect(esc).toMatchObject({ rule: "ESCALATE_HANDOFF_TIMEOUT", level: "needs_decision", status: "open" });
    expect(esc.why).toBe("Nobody accepted the inspect handoff within 15 min (the limit for severity 5).");
    expect(esc.tried.some((line) => line.includes(`D1: busy on ${first}`))).toBe(true);
    expect(task(sim, second).escalationId).toBe(esc.id);
  });

  it("times out only once per deadline, and holds one open escalation per task", () => {
    const { sim, second } = setup({ autoHuman: false });
    until(sim, () => events(sim, "handoff_failed", second).length > 0);
    run(sim, 10 * MIN);
    expect(events(sim, "handoff_failed", second)).toHaveLength(1);
    expect(sim.escalations.filter((e) => e.taskIds.includes(second) && e.level !== "notice")).toHaveLength(1);
  });

  it("the task is still picked up as soon as the drone is free", () => {
    const { sim, second } = setup();
    until(sim, () => task(sim, second).workerId === "D1");
    expect(task(sim, second).state).toBe("inspect");
  });

  it("the naive baseline records the timeout but does not escalate it", () => {
    const { sim, second } = setup({ dispatcher: naiveDispatcher, autoHuman: false });
    until(sim, () => events(sim, "handoff_failed", second).length > 0);
    run(sim, 5);
    expect(sim.escalations).toHaveLength(0);
  });

  it("late: a worker who does not arrive in time fails the handoff and is retried once", () => {
    const sim = quietSim(10, { autoHuman: false });
    const id = place(sim, FAR);
    until(sim, () => task(sim, id).workerId === "G1" && task(sim, id).phase === "traveling");
    setWorker(sim, "G1", { speedMps: 0.001 }); // stuck in the mud
    until(sim, () => events(sim, "handoff_failed", id).length > 0);
    expect(events(sim, "handoff_failed", id)[0]).toMatchObject({ reason: "late", workerId: "G1" });
    expect(sim.clock.tick).toBe(task(sim, id).handoff!.offeredTick);
    expect(whys(sim, id, "retry")[0]).toMatchObject({ rule: "RETRY_AFTER_LATE" });
    expect(task(sim, id).failedWorkerIds).toEqual(["G1"]);
    // The retry goes to the next-best worker.
    until(sim, () => task(sim, id).workerId !== null);
    expect(task(sim, id).workerId).toBe("T1");
  });

  it("a failed retry escalates, even when a third worker is free to take it", () => {
    const sim = quietSim(10, { autoHuman: false, crew: [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1"), createTechnician("T2")] });
    const id = place(sim, FAR);
    until(sim, () => task(sim, id).workerId === "G1" && task(sim, id).phase === "traveling");
    setWorker(sim, "G1", { speedMps: 0.001 });
    until(sim, () => task(sim, id).workerId === "T1");
    setWorker(sim, "T1", { speedMps: 0.001 });
    until(sim, () => events(sim, "handoff_failed", id).length === 2);
    expect(whys(sim, id, "handoff").at(-1)).toMatchObject({ rule: "HANDOFF_RETRY_FAILED", workerId: "T1" });
    run(sim, 1);
    const esc = sim.escalations.find((e) => e.taskIds.includes(id))!;
    expect(esc).toMatchObject({ rule: "ESCALATE_RETRY_FAILED", level: "needs_decision" });
    expect(esc.headline).toContain("handoff for verify failed twice");
  });
});

describe("failure case e: technician shift ends mid-repair", () => {
  it("naive starts a repair it cannot finish: released at 16:00, progress lost, +20 next time", () => {
    const sim = quietSim(15, { dispatcher: naiveDispatcher });
    const id = place(sim, { severity: 4 }, { needsReplace: false });
    until(sim, () => task(sim, id).state === "repair" && task(sim, id).phase === "working");
    const before = task(sim, id).workLeftS;
    until(sim, () => events(sim, "released", id).length > 0);
    expect(sim.clock.tick).toBe(16 * TICKS_PER_HOUR);
    expect(events(sim, "released", id)[0]).toMatchObject({ workerId: "T1", cause: "shift ended" });
    expect(whys(sim, id, "release")[0]).toMatchObject({ rule: "RELEASE_SHIFT_ENDED", workerId: "T1" });
    expect(task(sim, id)).toMatchObject({ state: "repair", phase: "waiting", workerId: null, workLeftS: 0, interrupted: true });
    expect(before).toBeGreaterThan(0);
    expect(scoreTask(task(sim, id), sim.clock, sim.coord).interrupted).toBe(20);
    // Next morning the technician starts it again from scratch.
    until(sim, () => task(sim, id).phase === "working");
    expect(task(sim, id).workLeftS).toBe(DEFAULT_TASK_CONFIG.workSeconds.repair.hotspot);
    until(sim, () => task(sim, id).state === "done");
    expect(task(sim, id).interrupted).toBe(false);
  });

  it("Arien does not start it: no release, and the repair runs the next morning", () => {
    const sim = quietSim(15);
    const id = place(sim, { severity: 4 }, { needsReplace: false });
    until(sim, () => task(sim, id).state === "done");
    expect(events(sim, "released")).toHaveLength(0);
    expect(whys(sim, id, "hold").some((d) => d.rule === "HOLD_SHIFT_TOO_SHORT")).toBe(true);
    const accepted = events(sim, "handoff_accepted", id).find((e) => e.handoff === "fix")!;
    expect(accepted.tick).toBe(24 * TICKS_PER_HOUR + 8 * TICKS_PER_HOUR);
  });

  // A human override can still send the technician. Then the shift cuts the repair.
  // A 20-minute accept limit, so the timeout (and the human's override) lands before 16:00.
  const quick = { acceptWithinS: { 5: 1200, 4: 1200, 3: 1200, 2: 1200, 1: 1200 } };
  const overridden = (severity: Severity) => {
    const sim = quietSim(15, { autoHuman: false, coord: quick });
    const id = place(sim, { severity }, { needsReplace: false });
    until(sim, () => sim.escalations.some((e) => e.taskIds.includes(id) && e.level !== "notice" && e.status === "open"));
    const esc = sim.escalations.find((e) => e.taskIds.includes(id) && e.status === "open")!;
    applyHumanAction(sim, { escalationId: esc.id, action: "reassign", workerId: "T1" });
    until(sim, () => events(sim, "released", id).length > 0);
    run(sim, 1);
    return { sim, id };
  };

  it("a severity 4 repair cut off by shift end escalates", () => {
    const { sim, id } = overridden(4);
    const esc = sim.escalations.find((e) => e.rule === "ESCALATE_SHIFT_CUT_REPAIR")!;
    expect(esc).toMatchObject({ level: "needs_decision", taskIds: [id] });
    expect(esc.headline).toContain("repair was cut off when the shift ended");
    expect(esc.suggested).toMatchObject({ action: "wait", label: "Wait for T1, shift starts 08:00" });
  });

  it("a severity 3 one does not", () => {
    const { sim } = overridden(3);
    expect(sim.escalations.some((e) => e.rule === "ESCALATE_SHIFT_CUT_REPAIR")).toBe(false);
  });
});

// ---------- 5. escalation and the human ----------

describe("escalation", () => {
  const stuck = (options: Partial<SimOptions> = {}) => {
    const sim = quietSim(1, { autoHuman: false, ...options });
    const id = place(sim, { severity: 5 }, { needsReplace: false });
    until(sim, () => sim.escalations.some((e) => e.level === "needs_decision"));
    return { sim, id, esc: sim.escalations.find((e) => e.level === "needs_decision")! };
  };

  it("shows the human a headline, the trigger, what was tried, options, and a default", () => {
    const { sim, id, esc } = stuck();
    expect(esc.headline.length).toBeGreaterThan(10);
    expect(esc.why).toContain("every worker who can repair is off shift");
    expect(esc.taskIds).toEqual([id]);
    expect(esc.tried.length).toBeGreaterThan(0);
    expect(esc.tried.join("\n")).toContain("T1: off shift until 08:00");
    expect(esc.options.map((o) => o.action)).toEqual(["approve", "reassign", "take_over", "wait"]);
    expect(esc.options[0].label).toBe(esc.suggested.label);
    expect(esc.defaultAtTick).toBe(esc.openedTick + 10 * MIN);
    expect(whys(sim, id, "escalate").at(-1)!.why).toContain("Suggested: Wait for T1, shift starts 08:00.");
  });

  it("a new severity-5 fault is a notice: logged, nothing to decide", () => {
    const sim = quietSim(10);
    const id = place(sim, { severity: 5 });
    run(sim, 1);
    expect(sim.escalations[0]).toMatchObject({ level: "notice", rule: "NOTICE_SEV5", status: "resolved", taskIds: [id] });
    expect(task(sim, id).escalationId).toBeNull();
    run(sim, 50);
    expect(sim.escalations.filter((e) => e.rule === "NOTICE_SEV5")).toHaveLength(1);
  });

  it("escalates at once when nobody in the crew has the skill", () => {
    const sim = quietSim(10, { crew: [createGroundRobot("G1"), createTechnician("T1")], autoHuman: false });
    const id = place(sim, { severity: 2 });
    run(sim, 1);
    expect(sim.escalations[0]).toMatchObject({ rule: "ESCALATE_NO_SKILL_IN_CREW", taskIds: [id] });
    expect(sim.escalations[0].why).toBe("No worker in the crew has the inspect skill.");
    expect(whys(sim, id, "hold")[0].rule).toBe("HOLD_NO_CAPABLE_WORKER");
  });

  it("the stand-in human approves the suggestion 10 minutes later", () => {
    const { sim, id, esc } = stuck({ autoHuman: true });
    until(sim, () => esc.status === "resolved");
    expect(sim.clock.tick).toBe(esc.openedTick + 10 * MIN);
    expect(esc).toMatchObject({ resolvedBy: "auto-human", resolution: "Wait for T1, shift starts 08:00" });
    expect(task(sim, id)).toMatchObject({ escalationId: null, snoozeUntilTick: 8 * TICKS_PER_HOUR });
    expect(whys(sim, id, "resolve")[0]).toMatchObject({ rule: "HUMAN_APPROVE" });
    expect(events(sim, "resolved", id)[0]).toMatchObject({ by: "auto-human", action: "approve" });
  });

  it("without the stand-in, an escalation stays open until a person answers", () => {
    const { sim, esc } = stuck();
    run(sim, 2 * TICKS_PER_HOUR);
    expect(esc.status).toBe("open");
    expect(sim.escalations.filter((e) => e.level === "needs_decision")).toHaveLength(1);
  });

  it("wait: the person picks the time", () => {
    const { sim, id, esc } = stuck();
    const until9 = 9 * TICKS_PER_HOUR;
    applyHumanAction(sim, { escalationId: esc.id, action: "wait", untilTick: until9, by: "ansh" });
    expect(esc).toMatchObject({ status: "resolved", resolvedBy: "ansh" });
    expect(task(sim, id).snoozeUntilTick).toBe(until9);
    expect(whys(sim, id, "resolve")[0].rule).toBe("HUMAN_WAIT");
    expect(() => applyHumanAction(sim, { escalationId: esc.id, action: "wait", untilTick: until9 })).toThrow(/already resolved/);
  });

  it("take over: the task is marked done and logged as an override", () => {
    const { sim, id, esc } = stuck();
    applyHumanAction(sim, { escalationId: esc.id, action: "take_over" });
    expect(task(sim, id)).toMatchObject({ state: "done", resolution: "taken_over", doneTick: sim.clock.tick });
    expect(whys(sim, id, "override")[0]).toMatchObject({ rule: "OVERRIDE_TAKE_OVER" });
    run(sim, 8 * TICKS_PER_HOUR);
    expect(events(sim, "handoff_accepted", id).filter((e) => e.handoff === "fix")).toHaveLength(0);
  });

  it("reassign: can break the soft rules, but not capability", () => {
    const { sim, id, esc } = stuck();
    expect(() => applyHumanAction(sim, { escalationId: esc.id, action: "reassign", workerId: "D1" })).toThrow(/capability cannot be overridden/);
    applyHumanAction(sim, { escalationId: esc.id, action: "reassign", workerId: "T1" });
    expect(whys(sim, id, "override")[0]).toMatchObject({ rule: "OVERRIDE_REASSIGN", workerId: "T1" });
    until(sim, () => task(sim, id).workerId === "T1");
    expect(sim.clock.tick).toBe(8 * TICKS_PER_HOUR); // still has to be on shift
  });

  it("replaying the same human actions on the same seed reproduces the run", () => {
    const play = () => {
      const sim = createSim({ seed: "replay", autoHuman: false });
      for (let i = 0; i < 6000; i++) {
        stepSim(sim);
        if (sim.clock.tick % 500 === 0) {
          for (const esc of sim.escalations.filter((e) => e.status === "open")) {
            applyHumanAction(sim, esc.taskIds.length === 1 && esc.rule !== "ESCALATE_STRANDED" ? { escalationId: esc.id, action: "take_over" } : { escalationId: esc.id, action: "approve" });
          }
        }
      }
      return JSON.stringify([sim.decisions, sim.events, sim.tasks, sim.workers, sim.escalations]);
    };
    expect(play()).toBe(play());
  });
});

// ---------- 5b. escalation noise ----------
// One escalation per stuck task. Raised again only when its situation changes (severity,
// another failure, a worse blocker) or after a long time with no change. A snooze ending
// raises nothing, and a handoff only ever times out once.

describe("escalation noise: when a stuck task is raised again", () => {
  const coord = DEFAULT_COORDINATION_CONFIG;
  const REMINDER_TICKS = coord.reminderAfterS / 10;
  const at = (hour: number) => advance(createClock(), Math.round(hour * TICKS_PER_HOUR));
  const dayShift = () => [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1")];
  const alwaysOn = () => [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1", { shift: null })];

  const repair = (id: string, severity: Severity, extra: Partial<Task> = {}): Task => ({
    ...createTask({ id: `F${id}`, type: "hotspot", severity, startTick: 0, location: { row: 2, colStart: 2, colEnd: 2, x: 2.2, y: 12 } }),
    state: "repair",
    ...extra,
  });
  /** What the task looked like when it was last raised: a few minutes before 10:00 by default. */
  const was = (extra: Partial<EscalatedState> = {}): EscalatedState => ({ step: "repair", severity: 3, disruptions: 0, blockerRank: 0, tick: 9.9 * TICKS_PER_HOUR, ...extra });

  // T1 is tied up on another job, so nothing here gets a worker on this tick.
  const tiedUp = () => repair("9999", 1, { workerId: "T1", phase: "working" });
  const raised = (clock: ReturnType<typeof at>, tasks: Task[], workers = dayShift()) =>
    arienDispatcher({ clock, tasks: [tiedUp(), ...tasks], workers, busy: new Set(["T1"]), coord, taskConfig: DEFAULT_TASK_CONFIG }).filter(
      (d): d is Extract<DispatchDecision, { kind: "escalate" }> => d.kind === "escalate" && d.level !== "notice",
    );

  it("raises a stuck task the first time", () => {
    const [d] = raised(at(10), [repair("0001", 3, { alert: "timed_out" })]);
    expect(d).toMatchObject({ rule: "ESCALATE_HANDOFF_TIMEOUT", taskIds: ["T0001"], blocker: "capacity" });
  });

  it("raises nothing for a task that never had trouble", () => {
    expect(raised(at(10), [repair("0001", 3)])).toEqual([]);
  });

  it("raises nothing while its escalation is still open", () => {
    expect(raised(at(10), [repair("0001", 3, { alert: "timed_out", escalationId: "E0001", escalated: was() })])).toEqual([]);
  });

  it("the same stuck situation is not raised again, even though the alert is still set", () => {
    expect(raised(at(10), [repair("0001", 3, { alert: "timed_out", escalated: was() })])).toEqual([]);
    expect(raised(at(10), [repair("0001", 3, { escalated: was() })])).toEqual([]);
  });

  it("raises again when the severity changes", () => {
    const [d] = raised(at(10), [repair("0001", 4, { escalated: was({ severity: 3 }) })]);
    expect(d.rule).toBe("ESCALATE_SITUATION_CHANGED");
    expect(d.why).toBe("Already raised for repair, and since then: severity changed from 3 to 4.");
    expect(d.headline).toBe("Sev 4 hotspot at R03-P03: severity changed from 3 to 4");
  });

  it("raises again after another failure on the same step", () => {
    const [d] = raised(at(10), [repair("0001", 3, { disruptions: 2, escalated: was({ disruptions: 1 }) })]);
    expect(d.rule).toBe("ESCALATE_SITUATION_CHANGED");
    expect(d.why).toContain("1 more failed handoff on this step");
  });

  it("raises again when the blocker gets worse: every worker who can take it goes off shift", () => {
    const [d] = raised(at(17), [repair("0001", 3, { escalated: was({ blockerRank: 0 }) })]);
    expect(d).toMatchObject({ rule: "ESCALATE_SITUATION_CHANGED", blocker: "off_shift" });
    expect(d.why).toContain("every worker who can repair is now off shift");
    expect(d.suggested).toMatchObject({ action: "wait", label: "Wait for T1, shift starts 08:00" });
  });

  it("tasks that all became blocked the same way share one escalation", () => {
    const tasks = ["0001", "0002", "0003"].map((id) => repair(id, 3, { escalated: was() }));
    const out = raised(at(17), tasks);
    expect(out).toHaveLength(1);
    expect(out[0].taskIds).toEqual(["T0001", "T0002", "T0003"]);
    expect(out[0].headline).toMatch(/^3 tasks changed:/);
  });

  it("a better blocker raises nothing: a shift starting is good news", () => {
    // Last raised overnight (nobody on shift). Now it is 08:00 and the technician is back.
    expect(raised(at(8), [repair("0001", 3, { alert: "timed_out", escalated: was({ blockerRank: 1 }) })])).toEqual([]);
    expect(raised(at(10), [repair("0001", 3, { escalated: was({ blockerRank: 1 }) })])).toEqual([]);
  });

  it("a new step is a new situation: a timeout there is raised even though the last step was", () => {
    const task = repair("0001", 3, { alert: "timed_out", escalated: was({ step: "verify" }) });
    expect(raised(at(10), [task])).toMatchObject([{ rule: "ESCALATE_HANDOFF_TIMEOUT" }]);
  });

  it("a new step alone, with nothing wrong, raises nothing", () => {
    expect(raised(at(10), [repair("0001", 3, { escalated: was({ step: "verify" }) })])).toEqual([]);
  });

  describe("reminders", () => {
    const t0 = 1000;
    const stuck = (extra: Partial<Task> = {}) => repair("0001", 3, { escalated: was({ tick: t0 }), ...extra });
    const clockAt = (tick: number) => advance(createClock(), tick);

    it("come one reminder interval after the last escalation, and not a tick before", () => {
      expect(raised(clockAt(t0 + REMINDER_TICKS - 1), [stuck()], alwaysOn())).toEqual([]);
      const [d] = raised(clockAt(t0 + REMINDER_TICKS), [stuck()], alwaysOn());
      expect(d).toMatchObject({ rule: "REMIND_STILL_WAITING", taskIds: ["T0001"] });
      expect(d.why).toBe("No change in the 8 h since this task was last raised. Still waiting for repair.");
    });

    it("count from the end of a snooze, so the snooze ending raises nothing itself", () => {
      const snoozed = stuck({ snoozeUntilTick: t0 + 2000 });
      expect(raised(clockAt(t0 + 2000), [snoozed], alwaysOn())).toEqual([]); // the snooze ends: nothing
      expect(raised(clockAt(t0 + REMINDER_TICKS), [snoozed], alwaysOn())).toEqual([]); // would be due without the snooze
      expect(raised(clockAt(t0 + 2000 + REMINDER_TICKS - 1), [snoozed], alwaysOn())).toEqual([]);
      expect(raised(clockAt(t0 + 2000 + REMINDER_TICKS), [snoozed], alwaysOn())).toMatchObject([{ rule: "REMIND_STILL_WAITING" }]);
    });

    it("tasks reminded at the same time share one escalation", () => {
      const out = raised(clockAt(t0 + REMINDER_TICKS), [stuck(), repair("0002", 3, { escalated: was({ tick: t0 }) })], alwaysOn());
      expect(out).toHaveLength(1);
      expect(out[0].taskIds).toEqual(["T0001", "T0002"]);
      expect(out[0].headline).toBe("2 tasks are still waiting for repair, nothing has changed");
    });

    it("a task that is no longer waiting gets no reminder", () => {
      expect(raised(clockAt(t0 + REMINDER_TICKS), [stuck({ workerId: "T1", phase: "working" })], alwaysOn())).toEqual([]);
    });
  });
});

describe("escalation noise: whole sim", () => {
  const SLOW_INSPECT = { workSeconds: { ...DEFAULT_TASK_CONFIG.workSeconds, inspect: { ...DEFAULT_TASK_CONFIG.workSeconds.inspect, hotspot: 30 * 3600 } } };
  const escalationsFor = (sim: Sim, id: string) => sim.escalations.filter((e) => e.taskIds.includes(id) && e.level !== "notice");

  it("a snooze ending does not start a new escalation, and the handoff does not time out again", () => {
    const sim = quietSim(1, { autoHuman: false });
    const id = place(sim, { severity: 4 }, { needsReplace: false }); // 30 min to accept, nobody on shift until 08:00
    until(sim, () => escalationsFor(sim, id).length > 0);
    const snoozeEnd = 3 * TICKS_PER_HOUR;
    applyHumanAction(sim, { escalationId: escalationsFor(sim, id)[0].id, action: "wait", untilTick: snoozeEnd });
    run(sim, 7 * TICKS_PER_HOUR - sim.clock.tick); // past the snooze end and several accept windows, before the shift
    expect(sim.clock.tick).toBe(7 * TICKS_PER_HOUR);
    expect(task(sim, id).snoozeUntilTick).toBe(snoozeEnd);
    expect(escalationsFor(sim, id)).toHaveLength(1);
    expect(events(sim, "handoff_failed", id).filter((e) => e.reason === "timed_out")).toHaveLength(1);
    expect(whys(sim, id).filter((d) => d.rule === "HANDOFF_TIMED_OUT")).toHaveLength(1);
    // The technician takes it at shift start, still with one escalation in total.
    until(sim, () => task(sim, id).workerId === "T1");
    expect(escalationsFor(sim, id)).toHaveLength(1);
  });

  it("a snooze never touches the handoff's deadline or its timed-out flag", () => {
    const sim = quietSim(1, { autoHuman: false });
    const id = place(sim, { severity: 4 }, { needsReplace: false });
    until(sim, () => escalationsFor(sim, id).length > 0);
    const before = task(sim, id).handoff!;
    applyHumanAction(sim, { escalationId: escalationsFor(sim, id)[0].id, action: "wait", untilTick: 5 * TICKS_PER_HOUR });
    expect(task(sim, id).handoff).toEqual(before);
    expect(before.timedOut).toBe(true);
  });

  it("a long unchanged wait gets one reminder per interval, and one timeout in total", () => {
    // D1 is busy for 30 hours, so the second fault waits for a drone that never comes free.
    const bigDrone = createDrone("D1", { battery: { capacityS: 40 * 3600, rechargeS: 3600 } });
    const sim = quietSim(10, { crew: [bigDrone, createGroundRobot("G1"), createTechnician("T1")], taskConfig: SLOW_INSPECT });
    place(sim, { severity: 5 });
    run(sim, 1);
    const second = place(sim, { severity: 5, row: 9 });
    run(sim, 17 * TICKS_PER_HOUR);
    const list = escalationsFor(sim, second);
    expect(list.map((e) => e.rule)).toEqual(["ESCALATE_HANDOFF_TIMEOUT", "REMIND_STILL_WAITING", "REMIND_STILL_WAITING"]);
    expect(list[1].openedTick - list[0].openedTick).toBe(8 * TICKS_PER_HOUR);
    expect(list[2].openedTick - list[1].openedTick).toBe(8 * TICKS_PER_HOUR);
    expect(list[1].why).toContain("No change in the 8 h");
    expect(events(sim, "handoff_failed", second).filter((e) => e.reason === "timed_out")).toHaveLength(1);
  });

  it("every escalation after the first for a task is a change or a reminder, never a repeat (2 days, both dispatchers)", () => {
    for (const dispatcher of [arienDispatcher, naiveDispatcher]) {
      for (const seed of [1, "arien-demo"]) {
        const sim = createSim({ seed, dispatcher });
        const last = new Map<string, { key: string; tick: number }>();
        for (let i = 0; i < 2 * 8640; i++) {
          stepSim(sim);
          for (const t of sim.tasks) {
            if (!t.escalated || t.escalated.tick !== sim.clock.tick) continue;
            const d = sim.decisions.findLast((x) => x.taskId === t.id && x.kind === "escalate" && x.tick === sim.clock.tick)!;
            const key = `${t.escalated.step}|${t.escalated.severity}|${t.escalated.disruptions}|${t.escalated.blockerRank}`;
            const prev = last.get(t.id);
            if (prev && d.rule === "REMIND_STILL_WAITING") expect(sim.clock.tick - prev.tick).toBeGreaterThanOrEqual(8 * TICKS_PER_HOUR);
            else if (prev && d.rule !== "ESCALATE_STRANDED") expect(key, `${t.id} raised twice for ${key} (${d.rule})`).not.toBe(prev.key);
            last.set(t.id, { key, tick: sim.clock.tick });
          }
        }
      }
    }
  });

  it("a handoff times out at most once between being offered and being accepted (2 days, both dispatchers)", () => {
    for (const dispatcher of [arienDispatcher, naiveDispatcher]) {
      const sim = runSim({ seed: "arien-demo", ticks: 2 * 8640, dispatcher });
      const open = new Map<string, boolean>(); // task -> already timed out since the last offer
      for (const e of sim.events) {
        if (e.kind === "handoff_offered") open.set(e.taskId, false);
        if (e.kind === "handoff_accepted") open.set(e.taskId, false);
        if (e.kind === "handoff_failed" && e.reason === "timed_out") {
          expect(open.get(e.taskId), `${e.taskId} timed out twice without a new offer`).toBe(false);
          open.set(e.taskId, true);
        }
      }
    }
  });

  it("tasks blocked the same way at the same moment share one escalation (shift end in the default run)", () => {
    const sim = runSim({ seed: "arien-demo", ticks: 8640 });
    const changed = sim.escalations.filter((e) => e.rule === "ESCALATE_SITUATION_CHANGED");
    expect(changed.length).toBeGreaterThan(0);
    expect(new Set(changed.map((e) => e.openedTick)).size).toBe(changed.length); // never two at the same tick
    expect(Math.max(...changed.map((e) => e.taskIds.length))).toBeGreaterThan(3);
  });
});

// ---------- 5c. bugs found in review ----------

describe("review fixes", () => {
  const coord = DEFAULT_COORDINATION_CONFIG;
  const decideWith = (hour: number, tasks: Task[], workers: Worker[]) =>
    arienDispatcher({ clock: advance(createClock(), Math.round(hour * TICKS_PER_HOUR)), tasks, workers, busy: new Set(), coord, taskConfig: DEFAULT_TASK_CONFIG });
  const inState = (id: string, state: Task["state"], severity: Severity, extra: Partial<Task> = {}): Task => ({
    ...createTask({ id: `F${id}`, type: "hotspot", severity, startTick: 0, location: { row: 2, colStart: 2, colEnd: 2, x: 2.2, y: 12 } }),
    state,
    ...extra,
  });

  describe("nobody left who can do the step", () => {
    it("robot cannot confirm and the crew has no person: escalates at once, not after the deadline", () => {
      const sim = quietSim(10, { crew: [createDrone("D1"), createGroundRobot("G1")], autoHuman: false });
      const id = place(sim, { severity: 4 }, { robotCanConfirm: false });
      until(sim, () => task(sim, id).failedWorkerIds.includes("G1"));
      const bouncedAt = sim.clock.tick;
      run(sim, 1);
      const esc = sim.escalations.find((e) => e.taskIds.includes(id))!;
      expect(esc).toMatchObject({ rule: "ESCALATE_NOBODY_LEFT", level: "needs_decision", openedTick: bouncedAt + 1 });
      expect(esc.headline).toBe("Sev 4 hotspot at R06-P11 needs verify, and everyone who can do it has already failed");
      expect(esc.why).toBe("G1 already failed verify on this task, and nobody else in the crew can verify. It will not move without a person.");
      expect(whys(sim, id, "hold").at(-1)).toMatchObject({ rule: "HOLD_NO_CAPABLE_WORKER" });
    });

    it("two robots: both fail, the retry is used up, and it is raised as nobody left", () => {
      const sim = quietSim(10, { crew: [createDrone("D1"), createGroundRobot("G1"), createGroundRobot("G2")], autoHuman: false });
      const id = place(sim, {}, { robotCanConfirm: false });
      until(sim, () => task(sim, id).failedWorkerIds.length === 2);
      run(sim, 1);
      expect(events(sim, "handoff_failed", id).map((e) => e.reason)).toEqual(["bounced", "bounced"]);
      expect(sim.escalations.filter((e) => e.taskIds.includes(id)).map((e) => e.rule)).toEqual(["ESCALATE_NOBODY_LEFT"]);
    });

    it("a person can still send a worker back with reassign", () => {
      const sim = quietSim(10, { crew: [createDrone("D1"), createGroundRobot("G1")], autoHuman: false });
      const id = place(sim, {}, { robotCanConfirm: false });
      until(sim, () => sim.escalations.some((e) => e.taskIds.includes(id)));
      applyHumanAction(sim, { escalationId: sim.escalations[0].id, action: "reassign", workerId: "G1" });
      until(sim, () => task(sim, id).workerId === "G1");
      expect(whys(sim, id, "override")[0].rule).toBe("OVERRIDE_REASSIGN");
    });

    it("is not raised while someone who has not failed is merely busy or off shift", () => {
      const sim = quietSim(1, { autoHuman: false }); // night: T1 can verify but is off shift
      const id = place(sim, { severity: 1 }, { robotCanConfirm: false });
      until(sim, () => task(sim, id).failedWorkerIds.includes("G1"));
      run(sim, 20);
      expect(sim.escalations.filter((e) => e.taskIds.includes(id))).toHaveLength(0);
    });
  });

  describe("shift fit is counted in whole ticks", () => {
    // A 45 min 5 s repair is not a whole number of 10-second ticks. Counted in raw seconds,
    // some start times let the technician begin a job that ended one tick after 16:00.
    const oddRepair = { workSeconds: { ...DEFAULT_TASK_CONFIG.workSeconds, repair: { ...DEFAULT_TASK_CONFIG.workSeconds.repair, hotspot: 2705 } } };

    it("Arien never starts a repair that the shift end cuts off, for any start time or distance", () => {
      let started = 0;
      for (let startTick = 16 * TICKS_PER_HOUR - 300; startTick < 16 * TICKS_PER_HOUR - 255; startTick++) {
        for (const col of [0, 3, 7, 13, 33]) {
          const sim = createSim({ seed: 1, faultConfig: NO_FAULTS, taskConfig: oddRepair, clock: advance(createClock(), startTick) });
          const id = place(sim, { col }, { needsReplace: false });
          sim.tasks = sim.tasks.map((t) => (t.id === id ? { ...t, state: "repair", handoff: { ...t.handoff!, kind: "fix" } } : t));
          run(sim, 320);
          expect(events(sim, "released"), `start tick ${startTick}, column ${col}`).toHaveLength(0);
          if (task(sim, id).state === "done") started += 1;
        }
      }
      expect(started).toBeGreaterThan(20); // and it does still start the ones that fit
    });

    it("the reason shows the rounded-up job time", () => {
      const sim = quietSim(15.5, { taskConfig: oddRepair });
      const id = place(sim, {}, { needsReplace: false });
      sim.tasks = sim.tasks.map((t) => (t.id === id ? { ...t, state: "repair" } : t));
      run(sim, 1);
      expect(whys(sim, id, "hold")[0].why).toMatch(/T1: shift ends in 30 min, job needs 46 min/);
    });
  });

  describe("no escalation for a task that gets its worker on the same tick", () => {
    it("a timed-out task with a free worker is assigned, not raised", () => {
      const decisions = decideWith(10, [inState("0001", "repair", 5, { alert: "timed_out" })], [createTechnician("T1")]);
      expect(decisions.map((d) => d.kind)).toEqual(["assign"]);
    });

    it("a failed retry is raised even though a worker takes it on the same tick", () => {
      const decisions = decideWith(10, [inState("0001", "repair", 3, { alert: "retry_failed" })], [createTechnician("T1")]);
      expect(decisions.map((d) => (d.kind === "escalate" ? d.rule : d.kind))).toEqual(["assign", "ESCALATE_RETRY_FAILED"]);
    });

    it("the same task with nobody free is raised", () => {
      const busyTech = inState("0002", "repair", 3, { workerId: "T1", phase: "working" });
      const decisions = arienDispatcher({
        clock: advance(createClock(), 10 * TICKS_PER_HOUR),
        tasks: [busyTech, inState("0001", "repair", 5, { alert: "timed_out" })],
        workers: [createTechnician("T1")],
        busy: new Set(["T1"]),
        coord,
        taskConfig: DEFAULT_TASK_CONFIG,
      });
      expect(decisions.map((d) => d.kind)).toEqual(["hold", "escalate"]);
    });

    it("a severity-5 notice is still sent for a fault assigned on the tick it appears", () => {
      const sim = quietSim(10);
      const id = place(sim, { severity: 5 });
      run(sim, 1);
      expect(task(sim, id).workerId).toBe("D1");
      expect(sim.escalations.map((e) => e.rule)).toEqual(["NOTICE_SEV5"]);
    });
  });

  describe("a timeout is never hidden behind a leftover alert", () => {
    it("a low-severity repair cut at shift end still raises its timeout", () => {
      const sim = quietSim(17, { autoHuman: false });
      const id = place(sim, { severity: 3 }, { needsReplace: false });
      // As it would be just after a shift cut: waiting on repair, never escalated, alert left set.
      sim.tasks = sim.tasks.map((t) => (t.id === id ? { ...t, state: "repair", alert: "shift_cut", interrupted: true, disruptions: 1, handoff: { ...t.handoff!, kind: "fix" } } : t));
      run(sim, 30);
      expect(sim.escalations).toHaveLength(0); // severity 3: the cut alone does not escalate
      until(sim, () => sim.escalations.length > 0);
      expect(task(sim, id).handoff!.timedOut).toBe(true);
      expect(sim.escalations[0]).toMatchObject({ rule: "ESCALATE_NO_WORKER_ON_SHIFT", taskIds: [id] });
    });

    it("a failed retry is not replaced by the timeout", () => {
      const sim = quietSim(1, { autoHuman: false });
      const id = place(sim, { severity: 5 });
      sim.tasks = sim.tasks.map((t) => (t.id === id ? { ...t, state: "repair", alert: "retry_failed", escalationId: "E9999", handoff: { ...t.handoff!, kind: "fix" } } : t));
      run(sim, 16 * MIN);
      expect(task(sim, id)).toMatchObject({ alert: "retry_failed" });
      expect(task(sim, id).handoff!.timedOut).toBe(true);
    });
  });

  describe("scoring", () => {
    it("a fault placed for a future tick never scores negative wait", () => {
      const future = createTask({ id: "F0001", type: "soiling", severity: 1, startTick: 500, location: { row: 0, colStart: 0, colEnd: 0, x: 0, y: 0 } });
      expect(scoreTask(future, advance(createClock(), 100), coord)).toMatchObject({ wait: 0, total: 20 });
    });
  });
});

// ---------- 6. the why log ----------

describe("why log", () => {
  const runs = [
    runSim({ seed: "arien-demo", ticks: 8640 }),
    runSim({ seed: 7, ticks: 2 * 8640, crew: [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1"), createTechnician("T2")] }),
    runSim({ seed: "arien-demo", ticks: 8640, dispatcher: naiveDispatcher }),
    runSim({ seed: 7, ticks: 8640, dispatcher: naiveDispatcher, crew: [createDrone("D1", { battery: { capacityS: 400, rechargeS: 600 } }), createGroundRobot("G1"), createTechnician("T1")] }),
  ];

  it("every decision has a reason and a rule from the fixed list", () => {
    for (const sim of runs) {
      expect(sim.decisions.length).toBeGreaterThan(50);
      for (const d of sim.decisions) {
        expect(d.why.length).toBeGreaterThan(15);
        expect(RULES).toContain(d.rule);
        expect(d.taskId).toMatch(/^[TR]\d{4}$/);
      }
    }
  });

  it("every assignment in the event log has a matching why record on the same tick", () => {
    for (const sim of runs) {
      for (const e of events(sim, "handoff_accepted")) {
        const record = sim.decisions.find((d) => d.tick === e.tick && d.taskId === e.taskId && d.workerId === e.workerId && (d.kind === "assign" || d.kind === "override"));
        expect(record, `${e.taskId} -> ${e.workerId} at tick ${e.tick}`).toBeDefined();
      }
    }
  });

  it("every failed handoff, release, and escalation has a why record too", () => {
    for (const sim of runs) {
      for (const e of events(sim, "handoff_failed")) {
        expect(sim.decisions.some((d) => d.tick === e.tick && d.taskId === e.taskId && (d.kind === "retry" || d.kind === "handoff" || d.kind === "release"))).toBe(true);
      }
      for (const e of events(sim, "escalated")) {
        expect(sim.decisions.some((d) => d.tick === e.tick && d.taskId === e.taskId && d.kind === "escalate")).toBe(true);
      }
      for (const e of events(sim, "released")) {
        expect(sim.decisions.some((d) => d.tick === e.tick && d.taskId === e.taskId && (d.kind === "release" || d.kind === "retry" || d.kind === "handoff"))).toBe(true);
      }
    }
  });

  it("Arien's assigns and holds show the score, and the parts add up to the total", () => {
    const arien = runs[0].decisions.filter((d) => d.kind === "assign" || d.kind === "hold");
    for (const d of arien) {
      const s = d.score!;
      expect(s.total).toBe(s.severity + s.wait + s.type + s.interrupted);
      expect(d.why).toContain(`score ${s.total} (sev ${s.severity} + wait ${s.wait} + type ${s.type}`);
    }
  });

  it("lists each worker considered, with one reason for each one rejected", () => {
    const arien = runs[0].decisions.filter((d) => d.kind === "assign" || d.kind === "hold");
    for (const d of arien) {
      for (const c of d.considered!) {
        if (c.ok) expect(c.reject).toBeUndefined();
        else expect(c.reject!.length).toBeGreaterThan(3);
      }
      if (d.kind === "assign") expect(d.considered!.find((c) => c.workerId === d.workerId)!.ok).toBe(true);
      else expect(d.considered!.every((c) => !c.ok)).toBe(true);
    }
  });

  it("a hold is logged when its reason changes, not every tick", () => {
    const sim = runs[0];
    const holds = sim.decisions.filter((d) => d.kind === "hold");
    expect(holds.length).toBeLessThan(sim.clock.tick / 10);
    const byTask = new Map<string, WhyRecord[]>();
    for (const h of holds) byTask.set(h.taskId, [...(byTask.get(h.taskId) ?? []), h]);
    const shape = (h: WhyRecord) => `${h.rule}|${h.why.split("Nobody can ")[1].split(" yet")[0]}|${h.considered!.map((c) => `${c.workerId}:${c.rejectKind}`)}`;
    for (const list of byTask.values()) {
      for (let i = 1; i < list.length; i++) expect(shape(list[i])).not.toBe(shape(list[i - 1]));
    }
  });

  it("prints two lines per decision: what, then why with the rule", () => {
    const record = runs[0].decisions.find((d) => d.kind === "assign")!;
    const [what, why] = formatDecision(record, runs[0].clock).split("\n");
    expect(what).toContain(`${record.taskId}  assign    ${record.workerId}`);
    expect(why).toBe(`    why: ${record.why}  [${record.rule}]`);
  });
});

// ---------- 7. naive baseline ----------

describe("naive baseline", () => {
  it("oldest first: ignores severity", () => {
    const sim = quietSim(10, { dispatcher: naiveDispatcher });
    const first = place(sim, { severity: 1 });
    run(sim, 1);
    const older = place(sim, { severity: 1, row: 3 });
    run(sim, 1);
    const urgent = place(sim, { severity: 5, row: 4 });
    until(sim, () => task(sim, urgent).state !== "detected");
    const order = events(sim, "handoff_accepted").filter((e) => e.handoff === "pickup").map((e) => e.taskId);
    expect(order).toEqual([first, older, urgent]);
  });

  it("first free worker in crew order: a technician listed first verifies, robot or not", () => {
    const sim = quietSim(10, { dispatcher: naiveDispatcher, crew: [createTechnician("T1"), createGroundRobot("G1"), createDrone("D1")] });
    const id = place(sim);
    until(sim, () => task(sim, id).state === "verify" && task(sim, id).workerId !== null);
    expect(task(sim, id).workerId).toBe("T1");
    expect(lastAssign(sim, id)).toMatchObject({ rule: "ASSIGN_FIRST_FREE" });
    expect(lastAssign(sim, id).why).toBe("Oldest waiting task. T1 is the first free worker with verify. No other checks.");
  });

  it("no battery check: it sends a nearly flat drone, which strands", () => {
    const drone = createDrone("D1");
    const sim = quietSim(10, { dispatcher: naiveDispatcher, crew: [{ ...drone, battery: { ...drone.battery!, chargeS: 120 } }, createGroundRobot("G1"), createTechnician("T1")] });
    place(sim);
    until(sim, () => worker(sim, "D1").status === "stranded");
    expect(sim.escalations[0].rule).toBe("ESCALATE_STRANDED"); // same safety net as Arien
  });

  it("gets the same safety net: the stranded drone is recovered and work carries on", () => {
    const drone = createDrone("D1");
    const sim = quietSim(10, { dispatcher: naiveDispatcher, crew: [{ ...drone, battery: { ...drone.battery!, chargeS: 120 } }, createGroundRobot("G1"), createTechnician("T1")] });
    const id = place(sim, {}, { needsReplace: false });
    until(sim, () => task(sim, id).state === "done");
    expect(events(sim, "recovered")).toHaveLength(1);
    expect(sim.escalations.every((e) => e.rule === "ESCALATE_STRANDED" && e.resolvedBy === "auto-human")).toBe(true);
  });

  it("makes no holds and no escalations of its own", () => {
    const sim = runSim({ seed: "arien-demo", ticks: 8640, dispatcher: naiveDispatcher });
    expect(sim.decisions.some((d) => d.kind === "hold")).toBe(false);
    expect(sim.escalations.every((e) => e.rule === "ESCALATE_STRANDED")).toBe(true);
  });

  it("faces exactly the same faults and outcomes as Arien", () => {
    const physics = (dispatcher: Dispatcher) =>
      runSim({ seed: "fair", ticks: 8640, dispatcher })
        .tasks.filter((t) => t.kind === "fault")
        .map((t) => [t.fault, t.needsReplace, t.robotCanConfirm, t.falseAlarm]);
    expect(physics(naiveDispatcher)).toEqual(physics(arienDispatcher));
    expect(physics(naiveDispatcher).length).toBeGreaterThan(20);
  });
});
