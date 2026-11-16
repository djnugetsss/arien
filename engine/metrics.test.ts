// Metrics are checked against answers worked out by hand from the event log, not just
// "a number comes out".
import { describe, expect, it } from "vitest";
import { advance, createClock } from "./clock";
import type { Dispatcher } from "./decisions";
import { arienDispatcher, naiveDispatcher } from "./dispatcher";
import type { Fault, FaultType, Severity } from "./faults";
import { createRecorder, mean, median, runWithMetrics, worst, type RunMetrics } from "./metrics";
import { createSim, injectFault, stepSim, type Sim, type SimEvent } from "./sim";
import type { FaultOutcomes } from "./tasks";
import { createDrone, createGroundRobot, createTechnician } from "./workers";

const TICKS_PER_HOUR = 360;
const NO_FAULTS = { perTickChance: { hotspot: 0, soiling: 0, string_outage: 0, tracker_stuck: 0 } };

function quiet(hour: number, extra: Partial<Parameters<typeof createSim>[0]> = {}): Sim {
  return createSim({ seed: 1, faultConfig: NO_FAULTS, clock: advance(createClock(), Math.round(hour * TICKS_PER_HOUR)), ...extra });
}

let seq = 0;
function place(sim: Sim, opts: { type?: FaultType; severity?: Severity; row?: number; col?: number } = {}, outcomes: Partial<FaultOutcomes> = {}): string {
  const { type = "hotspot", severity = 3, row = 5, col = 10 } = opts;
  seq += 1;
  const fault: Fault = {
    id: `F${8000 + seq}`,
    type,
    severity,
    startTick: sim.clock.tick + 1,
    location: { row, colStart: col, colEnd: col, x: col * sim.site.panelSpacingM, y: row * sim.site.rowPitchM },
  };
  return injectFault(sim, fault, outcomes).id;
}

/** Steps the sim, recording each tick, until the condition holds (or the tick limit). */
function drive(sim: Sim, rec: ReturnType<typeof createRecorder>, until: () => boolean, max = 20_000): void {
  for (let i = 0; i < max && !until(); i++) {
    stepSim(sim);
    rec.record();
  }
}
function driveTicks(sim: Sim, rec: ReturnType<typeof createRecorder>, n: number): void {
  for (let i = 0; i < n; i++) {
    stepSim(sim);
    rec.record();
  }
}
const events = <K extends SimEvent["kind"]>(sim: Sim, kind: K, taskId?: string) =>
  sim.events.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === kind && (!taskId || e.taskId === taskId));
const idle: Dispatcher = () => [];

describe("stats helpers", () => {
  it("median handles odd, even, one, and empty lists without changing the input", () => {
    const input = [5, 1, 3];
    expect(median(input)).toBe(3);
    expect(input).toEqual([5, 1, 3]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
  });
  it("worst and mean", () => {
    expect(worst([2, 9, 4])).toBe(9);
    expect(worst([])).toBeNull();
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([])).toBeNull();
  });
});

describe("fault wait time", () => {
  it("is detection to fixed for a finished fault", () => {
    const sim = quiet(10);
    const rec = createRecorder(sim);
    const id = place(sim, {}, { needsReplace: false });
    drive(sim, rec, () => sim.tasks.find((t) => t.id === id)!.state === "done");
    const m = rec.finish();
    const task = sim.tasks.find((t) => t.id === id)!;
    expect(m.faults).toHaveLength(1);
    expect(m.faults[0]).toMatchObject({ taskId: id, severity: 3, resolution: "repaired", doneTick: task.doneTick, createdTick: task.createdTick });
    expect(m.faults[0].waitTicks).toBe(task.doneTick! - task.createdTick);
    expect(m.completed).toBe(1);
    expect(m.unfinished).toBe(0);
  });

  it("charges a fault that is still open the time it has waited so far", () => {
    const sim = quiet(10, { dispatcher: idle });
    const rec = createRecorder(sim);
    const id = place(sim);
    driveTicks(sim, rec, 50);
    const m = rec.finish();
    expect(m.faults[0]).toMatchObject({ taskId: id, doneTick: null, responded: false });
    expect(m.faults[0].waitTicks).toBe(sim.clock.tick - m.faults[0].createdTick);
    expect(m.faults[0].responseTicks).toBe(m.faults[0].waitTicks);
    expect(m.completed).toBe(0);
    expect(m.unfinished).toBe(1);
  });

  it("a longer run charges an open fault more, so waiting longer never looks better", () => {
    const wait = (ticks: number) => {
      const sim = quiet(10, { dispatcher: idle });
      const rec = createRecorder(sim);
      place(sim);
      driveTicks(sim, rec, ticks);
      return rec.finish().faults[0].waitTicks;
    };
    expect(wait(100)).toBeGreaterThan(wait(50));
  });

  it("counts a false alarm and a person's take-over as completed", () => {
    const sim = quiet(10);
    const rec = createRecorder(sim);
    const id = place(sim, {}, { robotCanConfirm: false, falseAlarm: true });
    drive(sim, rec, () => sim.tasks.find((t) => t.id === id)!.state === "done");
    const m = rec.finish();
    expect(m.faults[0].resolution).toBe("false_alarm");
    expect(m.completed).toBe(1);
  });
});

describe("time to first inspection", () => {
  it("is zero when the drone is free on the tick the fault appears", () => {
    const sim = quiet(10);
    const rec = createRecorder(sim);
    place(sim);
    driveTicks(sim, rec, 3);
    expect(rec.finish().faults[0]).toMatchObject({ responseTicks: 0, responded: true });
  });

  it("matches the accepted pickup handoff in the event log", () => {
    const sim = quiet(10, { crew: [createDrone("D1", { position: { x: 0, y: 0 } }), createGroundRobot("G1"), createTechnician("T1")] });
    const rec = createRecorder(sim);
    const first = place(sim, { severity: 5, row: 19, col: 39 });
    const second = place(sim, { severity: 1 }); // the drone is busy with the first for a while
    drive(sim, rec, () => events(sim, "handoff_accepted", second).some((e) => e.handoff === "pickup"));
    const m = rec.finish();
    for (const id of [first, second]) {
      const accepted = events(sim, "handoff_accepted", id).find((e) => e.handoff === "pickup")!;
      const record = m.faults.find((f) => f.taskId === id)!;
      expect(record.responseTicks).toBe(accepted.tick - record.createdTick);
    }
    expect(m.faults.find((f) => f.taskId === second)!.responseTicks).toBeGreaterThan(0);
  });
});

describe("utilization", () => {
  it("each worker's busy ticks are exactly the ticks between accepting a job and finishing it", () => {
    const sim = quiet(10);
    const rec = createRecorder(sim);
    const id = place(sim, {}, { needsReplace: false });
    drive(sim, rec, () => sim.tasks.find((t) => t.id === id)!.state === "done");
    const m = rec.finish();
    const accepted = events(sim, "handoff_accepted", id);
    const finished = events(sim, "state", id).filter((e) => e.from !== "detected");
    expect(accepted.map((e) => e.workerId)).toEqual(["D1", "G1", "T1"]);
    accepted.forEach((a, i) => {
      const worker = m.workers.find((w) => w.id === a.workerId)!;
      expect(worker.busyTicks).toBe(finished[i].tick - a.tick);
      expect(worker.utilization).toBeCloseTo(worker.busyTicks / worker.onShiftTicks, 12);
    });
  });

  it("counts on-shift ticks from the shift, and every tick for workers with no shift", () => {
    const sim = quiet(7); // 07:00; the technician starts at 08:00
    const rec = createRecorder(sim);
    driveTicks(sim, rec, 4 * TICKS_PER_HOUR);
    const m = rec.finish();
    const start = 7 * TICKS_PER_HOUR;
    expect(m.workers.find((w) => w.id === "D1")!.onShiftTicks).toBe(4 * TICKS_PER_HOUR);
    expect(m.workers.find((w) => w.id === "G1")!.onShiftTicks).toBe(4 * TICKS_PER_HOUR);
    // Ticks start+1 .. start+1440 are recorded; the shift covers tick 2880 (08:00) onward.
    expect(m.workers.find((w) => w.id === "T1")!.onShiftTicks).toBe(start + 4 * TICKS_PER_HOUR - 8 * TICKS_PER_HOUR + 1);
    for (const w of m.workers) {
      expect(w.utilization).toBe(0);
      expect(w.busyTicks).toBe(0);
    }
  });

  it("never exceeds 100%, and a worker with no shift ticks reports 0", () => {
    const m = runWithMetrics({ seed: 3, ticks: 8640, dispatcher: arienDispatcher }).metrics;
    for (const w of m.workers) {
      expect(w.utilization).toBeGreaterThanOrEqual(0);
      expect(w.utilization).toBeLessThanOrEqual(1);
      expect(w.busyTicks).toBeLessThanOrEqual(w.onShiftTicks);
    }
    const night = quiet(1);
    const rec = createRecorder(night);
    driveTicks(night, rec, 100);
    expect(rec.finish().workers.find((w) => w.id === "T1")).toMatchObject({ onShiftTicks: 0, utilization: 0 });
  });
});

describe("failed handoffs", () => {
  it("counts a timeout when nobody can accept", () => {
    const sim = quiet(10, { crew: [createGroundRobot("G1"), createTechnician("T1")] }); // nobody can inspect
    const rec = createRecorder(sim);
    place(sim, { severity: 5 }); // 15 min to accept
    driveTicks(sim, rec, 16 * 6 + 5);
    expect(rec.finish().failedHandoffs).toEqual({ total: 1, timedOut: 1, dropped: 0, late: 0, bounced: 0 });
  });

  it("counts a robot that could not confirm as bounced", () => {
    const sim = quiet(10);
    const rec = createRecorder(sim);
    const id = place(sim, {}, { robotCanConfirm: false, needsReplace: false });
    drive(sim, rec, () => sim.tasks.find((t) => t.id === id)!.state === "done");
    expect(rec.finish().failedHandoffs).toEqual({ total: 1, timedOut: 0, dropped: 0, late: 0, bounced: 1 });
  });

  it("counts a drone that dies on the way as dropped, and the strandings", () => {
    const weak = createDrone("D1", { battery: { capacityS: 10, rechargeS: 600 } });
    const sim = quiet(10, { dispatcher: naiveDispatcher, crew: [weak, createGroundRobot("G1"), createTechnician("T1")], autoHuman: false });
    const rec = createRecorder(sim);
    place(sim, { row: 19, col: 39 });
    drive(sim, rec, () => sim.workers[0].status === "stranded");
    const m = rec.finish();
    expect(m.failedHandoffs.dropped).toBe(1);
    expect(m.failedHandoffs.total).toBe(1);
    expect(m.strandings).toBe(1);
    expect(m.escalations).toBe(1); // the urgent "stranded" escalation
  });

  it("stranded time runs from the battery dying until a technician brings the drone home", () => {
    const weak = createDrone("D1", { battery: { capacityS: 10, rechargeS: 600 } });
    const sim = quiet(10, { dispatcher: naiveDispatcher, crew: [weak, createGroundRobot("G1"), createTechnician("T1")], autoHuman: false });
    const rec = createRecorder(sim);
    place(sim, { row: 19, col: 39 });
    drive(sim, rec, () => events(sim, "recovered").length > 0);
    const stranded = events(sim, "stranded")[0];
    const recovered = events(sim, "recovered")[0];
    const drone = rec.finish().workers[0];
    expect(drone.strandedTicks).toBe(recovered.tick - stranded.tick);
    expect(drone.strandedTicks).toBeGreaterThan(20);
  });

  it("totals match the event log on a long run", () => {
    const { sim, metrics } = runWithMetrics({ seed: 2, ticks: 2 * 8640 });
    expect(metrics.failedHandoffs.total).toBe(events(sim, "handoff_failed").length);
    const f = metrics.failedHandoffs;
    expect(f.timedOut + f.dropped + f.late + f.bounced).toBe(f.total);
  });
});

describe("work thrown away", () => {
  const cutOff = (dispatcher: Dispatcher) => {
    const sim = quiet(15, { dispatcher, autoHuman: false });
    const rec = createRecorder(sim);
    const id = place(sim, { severity: 4 }, { needsReplace: false });
    drive(sim, rec, () => events(sim, "released", id).length > 0 || sim.clock.tick > 16.5 * TICKS_PER_HOUR);
    return { sim, id, m: rec.finish() };
  };

  it("naive starts a repair at 15:xx and loses it at 16:00; the lost work is the time on site", () => {
    const { sim, id, m } = cutOff(naiveDispatcher);
    const released = events(sim, "released", id)[0];
    const arrived = events(sim, "handoff_completed", id).filter((e) => e.handoff === "fix")[0];
    expect(m.cutOffJobs).toBe(1);
    expect(m.lostWorkTicks).toBe(released.tick - arrived.tick);
    expect(m.lostWorkTicks).toBeGreaterThan(0);
  });

  it("Arien does not start what it cannot finish, so nothing is lost", () => {
    const { m } = cutOff(arienDispatcher);
    expect(m.cutOffJobs).toBe(0);
    expect(m.lostWorkTicks).toBe(0);
  });

  it("a trip cut short before arriving is a dropped handoff, not lost work", () => {
    const weak = createDrone("D1", { battery: { capacityS: 10, rechargeS: 600 } });
    const sim = quiet(10, { dispatcher: naiveDispatcher, crew: [weak, createGroundRobot("G1"), createTechnician("T1")], autoHuman: false });
    const rec = createRecorder(sim);
    place(sim, { row: 19, col: 39 });
    drive(sim, rec, () => sim.workers[0].status === "stranded");
    expect(rec.finish()).toMatchObject({ cutOffJobs: 0, lostWorkTicks: 0 });
  });
});

describe("escalations counted", () => {
  it("notices do not count as work for a person", () => {
    const sim = quiet(10);
    const rec = createRecorder(sim);
    place(sim, { severity: 5 });
    driveTicks(sim, rec, 5);
    expect(sim.escalations.map((e) => e.level)).toEqual(["notice"]);
    expect(rec.finish().escalations).toBe(0);
  });
});

describe("metrics are deterministic", () => {
  const run = (seed: number, dispatcher: Dispatcher) => runWithMetrics({ seed, ticks: 8640, dispatcher }).metrics;

  it("the same seed gives identical metrics", () => {
    for (const dispatcher of [naiveDispatcher, arienDispatcher]) {
      expect(JSON.stringify(run(4, dispatcher))).toBe(JSON.stringify(run(4, dispatcher)));
    }
  });

  it("different seeds give different metrics", () => {
    expect(JSON.stringify(run(1, arienDispatcher))).not.toBe(JSON.stringify(run(2, arienDispatcher)));
  });

  it("recording does not change the run", () => {
    const plain = createSim({ seed: 6 });
    for (let i = 0; i < 8640; i++) stepSim(plain);
    const { sim } = runWithMetrics({ seed: 6, ticks: 8640 });
    expect(JSON.stringify([sim.events, sim.decisions, sim.tasks, sim.workers])).toBe(JSON.stringify([plain.events, plain.decisions, plain.tasks, plain.workers]));
  });

  it("covers the whole run", () => {
    const m: RunMetrics = run(1, arienDispatcher);
    expect(m.ticks).toBe(8640);
    expect(m.faults.length).toBeGreaterThan(20);
    expect(m.completed + m.unfinished).toBe(m.faults.length);
    for (const w of m.workers) expect(w.onShiftTicks).toBeLessThanOrEqual(m.ticks);
  });
});
