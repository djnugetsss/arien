import { describe, expect, it } from "vitest";
import type { Fault } from "./faults";
import { createDrone } from "./workers";
import {
  DEFAULT_TASK_CONFIG,
  createRecoverTask,
  handoffKindFor,
  NEXT_STATES,
  TASK_STATES,
  canTransition,
  createTask,
  skillFor,
  stateAfterWork,
  transition,
  workSecondsFor,
} from "./tasks";

const fault: Fault = {
  id: "F0007",
  type: "hotspot",
  severity: 3,
  startTick: 42,
  location: { row: 2, colStart: 5, colEnd: 5, x: 5.5, y: 12 },
};

describe("task lifecycle", () => {
  it("a new task starts detected, waiting, unassigned, at the fault", () => {
    const task = createTask(fault);
    expect(task).toMatchObject({ id: "T0007", state: "detected", phase: "waiting", workerId: null, createdTick: 42, doneTick: null });
    expect(task.target).toEqual({ x: 5.5, y: 12 });
  });

  it("allows exactly the documented moves", () => {
    const allowed = TASK_STATES.flatMap((from) => TASK_STATES.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`));
    expect(allowed).toEqual([
      "detected->inspect",
      "inspect->verify",
      "verify->repair",
      "verify->replace",
      "verify->done",
      "repair->done",
      "replace->done",
    ]);
    expect(NEXT_STATES.done).toEqual([]);
  });

  it("throws on illegal moves", () => {
    const task = createTask(fault);
    expect(() => transition(task, "repair")).toThrow(/illegal/);
    expect(() => transition(task, "done")).toThrow(/illegal/);
    expect(() => transition(transition(task, "inspect"), "done")).toThrow(/illegal/);
    expect(() => transition(transition(task, "inspect"), "inspect")).toThrow(/illegal/);
  });

  it("verify branches to repair or replace based on needsReplace", () => {
    const at = (needsReplace: boolean) => transition(transition(createTask(fault, { needsReplace }), "inspect"), "verify");
    expect(stateAfterWork(at(false))).toBe("repair");
    expect(stateAfterWork(at(true))).toBe("replace");
  });

  it("walks the full path both ways", () => {
    for (const needsReplace of [false, true]) {
      let task = transition(createTask(fault, { needsReplace }), "inspect");
      const path = [task.state];
      while (task.state !== "done") {
        task = transition(task, stateAfterWork(task));
        path.push(task.state);
      }
      expect(path).toEqual(["inspect", "verify", needsReplace ? "replace" : "repair", "done"]);
    }
  });

  it("each state needs the matching skill", () => {
    let task = createTask(fault);
    expect(skillFor(task)).toBe("inspect");
    task = transition(task, "inspect");
    expect(skillFor(task)).toBe("inspect");
    task = transition(task, "verify");
    expect(skillFor(task)).toBe("verify");
    expect(skillFor(transition(task, "repair"))).toBe("repair");
    expect(skillFor(transition(task, "replace"))).toBe("replace");
    expect(skillFor(transition(transition(task, "repair"), "done"))).toBeNull();
  });

  it("work time comes from the config and only exists in working states", () => {
    const task = transition(createTask(fault), "inspect");
    expect(workSecondsFor(task)).toBe(DEFAULT_TASK_CONFIG.workSeconds.inspect.hotspot);
    expect(workSecondsFor(createTask(fault))).toBe(DEFAULT_TASK_CONFIG.workSeconds.inspect.hotspot); // detected: next step is inspect
    expect(() => stateAfterWork(createTask(fault))).toThrow();
  });

  it("a false alarm is only possible when the robot cannot confirm", () => {
    expect(createTask(fault, { falseAlarm: true }).falseAlarm).toBe(false);
    expect(createTask(fault, { robotCanConfirm: false, falseAlarm: true }).falseAlarm).toBe(true);
  });

  it("a recovery job is one step for a worker with the recover skill", () => {
    const drone = { ...createDrone("D1"), position: { x: 30, y: 40 } };
    const job = createRecoverTask(1, drone, 500);
    expect(job).toMatchObject({ id: "R0001", kind: "recover", label: "recover D1", state: "repair", recoverWorkerId: "D1", fault: null, createdTick: 500 });
    expect(job.target).toEqual({ x: 30, y: 40 });
    expect(skillFor(job)).toBe("recover");
    expect(handoffKindFor(job)).toBe("recover");
    expect(workSecondsFor(job)).toBe(DEFAULT_TASK_CONFIG.recoverSeconds);
  });

  it("names the handoff for each step", () => {
    let task = createTask(fault);
    expect(handoffKindFor(task)).toBe("pickup");
    task = transition(transition(task, "inspect"), "verify");
    expect(handoffKindFor(task)).toBe("confirm");
    expect(handoffKindFor(transition(task, "repair"))).toBe("fix");
    expect(handoffKindFor(transition(task, "replace"))).toBe("fix");
  });

  it("does not mutate the task it was given", () => {
    const task = createTask(fault);
    transition(task, "inspect");
    expect(task.state).toBe("detected");
  });
});
