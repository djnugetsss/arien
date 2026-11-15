import { describe, expect, it } from "vitest";
import type { Fault } from "./faults";
import {
  DEFAULT_TASK_CONFIG,
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
    const task = createTask(fault, false);
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
      "repair->done",
      "replace->done",
    ]);
    expect(NEXT_STATES.done).toEqual([]);
  });

  it("throws on illegal moves", () => {
    const task = createTask(fault, false);
    expect(() => transition(task, "repair")).toThrow(/illegal/);
    expect(() => transition(task, "done")).toThrow(/illegal/);
    expect(() => transition(transition(task, "inspect"), "inspect")).toThrow(/illegal/);
  });

  it("verify branches to repair or replace based on needsReplace", () => {
    const at = (needsReplace: boolean) => transition(transition(createTask(fault, needsReplace), "inspect"), "verify");
    expect(stateAfterWork(at(false))).toBe("repair");
    expect(stateAfterWork(at(true))).toBe("replace");
  });

  it("walks the full path both ways", () => {
    for (const needsReplace of [false, true]) {
      let task = transition(createTask(fault, needsReplace), "inspect");
      const path = [task.state];
      while (task.state !== "done") {
        task = transition(task, stateAfterWork(task));
        path.push(task.state);
      }
      expect(path).toEqual(["inspect", "verify", needsReplace ? "replace" : "repair", "done"]);
    }
  });

  it("each state needs the matching skill", () => {
    let task = createTask(fault, false);
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
    const task = transition(createTask(fault, false), "inspect");
    expect(workSecondsFor(task)).toBe(DEFAULT_TASK_CONFIG.workSeconds.inspect.hotspot);
    expect(() => workSecondsFor(createTask(fault, false))).toThrow();
    expect(() => stateAfterWork(createTask(fault, false))).toThrow();
  });

  it("does not mutate the task it was given", () => {
    const task = createTask(fault, false);
    transition(task, "inspect");
    expect(task.state).toBe("detected");
  });
});
