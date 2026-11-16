import { describe, expect, it } from "vitest";
import { DEFAULT_COMPARE, METRICS, isTie, judge, makeCrew, runComparison, type Comparison } from "./compare";

const QUICK = { seeds: [1, 2], techCounts: [1, 2], days: 1 } as const;
/** Everything a comparison reports, without the functions inside each metric. */
const flat = (c: Comparison) => JSON.stringify(c.crews.map((crew) => [crew.techs, crew.rows.map((r) => [r.metric.key, r.naive, r.arien, r.judgement])]));

describe("judge: win, lose, tie, mixed", () => {
  const lower = (naive: Array<number | null>, arien: Array<number | null>) => judge(naive, arien, "lower", "hours");

  it("a win needs 4 of 5 seeds clearly better", () => {
    expect(lower([10, 10, 10, 10, 10], [5, 5, 5, 5, 5])).toMatchObject({ verdict: "win", better: 5, worse: 0, seeds: 5 });
    expect(lower([10, 10, 10, 10, 10], [5, 5, 5, 5, 20])).toMatchObject({ verdict: "win", better: 4, worse: 1 });
    expect(lower([10, 10, 10, 10, 10], [5, 5, 5, 20, 20]).verdict).toBe("mixed");
  });

  it("a loss needs 4 of 5 seeds clearly worse", () => {
    expect(lower([5, 5, 5, 5, 5], [10, 10, 10, 10, 10])).toMatchObject({ verdict: "lose", worse: 5 });
    expect(lower([5, 5, 5, 5, 5], [10, 10, 10, 10, 5]).verdict).toBe("lose");
    expect(lower([5, 5, 5, 5, 5], [10, 10, 10, 5, 5]).verdict).toBe("mixed");
  });

  it("a tie is when most seeds are within tolerance", () => {
    expect(lower([10, 10, 10, 10, 10], [10, 10.2, 9.9, 10, 10])).toMatchObject({ verdict: "tie", ties: 5 });
    expect(lower([10, 10, 10, 10, 10], [10, 10, 10, 10, 5]).verdict).toBe("tie");
    expect(lower([10, 10, 10, 10, 10], [10, 10, 10, 5, 5]).verdict).toBe("mixed");
  });

  it("higher-is-better flips the direction", () => {
    expect(judge([10, 10, 10, 10, 10], [20, 20, 20, 20, 20], "higher", "count").verdict).toBe("win");
    expect(judge([20, 20, 20, 20, 20], [10, 10, 10, 10, 10], "higher", "count").verdict).toBe("lose");
  });

  it("skips seeds where either side has no value, and never judges 'none' metrics", () => {
    expect(lower([10, null, 10, 10, 10], [5, 5, null, 5, 5])).toMatchObject({ verdict: "win", seeds: 3 });
    expect(judge([null, null], [1, 2], "lower", "hours")).toMatchObject({ verdict: "n/a", seeds: 0 });
    expect(judge([1, 2, 3], [9, 9, 9], "none", "count").verdict).toBe("n/a");
  });

  it("works with fewer seeds: 2 of 2 are needed", () => {
    expect(lower([10, 10], [5, 5]).verdict).toBe("win");
    expect(lower([10, 10], [5, 20]).verdict).toBe("mixed");
    expect(lower([10], [5]).verdict).toBe("win");
  });

  it("is symmetric: swapping the sides swaps win and lose", () => {
    const a = [10, 12, 9, 11, 30];
    const b = [5, 6, 20, 5, 6];
    expect(lower(a, b).better).toBe(lower(b, a).worse);
    expect(lower(a, b).worse).toBe(lower(b, a).better);
  });

  it("rejects mismatched lists", () => {
    expect(() => judge([1, 2], [1], "lower", "count")).toThrow();
  });
});

describe("ties by unit", () => {
  it("hours: within 5 minutes or 5%", () => {
    expect(isTie(10, 10.4, "hours")).toBe(true); // 4%
    expect(isTie(10, 11, "hours")).toBe(false);
    expect(isTie(0.01, 0.07, "hours")).toBe(true); // under 5 minutes
  });
  it("minutes, counts, and percent", () => {
    expect(isTie(0, 4, "minutes")).toBe(true);
    expect(isTie(0, 6, "minutes")).toBe(false);
    expect(isTie(20, 21, "count")).toBe(true);
    expect(isTie(20, 23, "count")).toBe(false);
    expect(isTie(0.5, 0.51, "percent")).toBe(true);
    expect(isTie(0.5, 0.6, "percent")).toBe(false);
  });
});

describe("crews", () => {
  it("one drone, one robot, and the requested technicians", () => {
    expect(makeCrew(4).map((w) => w.id)).toEqual(["D1", "G1", "T1", "T2", "T3", "T4"]);
    expect(makeCrew(1).map((w) => w.type)).toEqual(["drone", "ground_robot", "technician"]);
  });
  it("the unlimited-battery ablation only changes the drone's battery", () => {
    const normal = makeCrew(2);
    const big = makeCrew(2, "unlimited");
    expect(big[0].battery!.capacityS).toBeGreaterThan(normal[0].battery!.capacityS * 100);
    expect(big.slice(1)).toEqual(normal.slice(1));
    expect({ ...big[0], battery: null }).toEqual({ ...normal[0], battery: null });
  });
  it("needs at least one technician", () => {
    expect(() => makeCrew(0)).toThrow();
  });
});

describe("comparison run", () => {
  const cmp = runComparison(QUICK);

  it("covers every crew size and every metric, in a fixed order", () => {
    expect(cmp.crews.map((c) => c.techs)).toEqual([1, 2]);
    for (const crew of cmp.crews) expect(crew.rows.map((r) => r.metric.key)).toEqual(METRICS.map((m) => m.key));
    expect(new Set(METRICS.map((m) => m.key)).size).toBe(METRICS.length);
    expect(cmp.ticks).toBe(8640);
  });

  it("is deterministic: the same options give the same table", () => {
    expect(flat(runComparison(QUICK))).toBe(flat(cmp));
  });

  it("different seeds give a different table", () => {
    expect(flat(runComparison({ ...QUICK, seeds: [3, 4] }))).not.toBe(flat(cmp));
  });

  it("both dispatchers face exactly the same faults on every seed and crew size", () => {
    for (const crew of cmp.crews) {
      expect(crew.naiveRuns).toHaveLength(2);
      crew.naiveRuns.forEach((naive, i) => {
        const key = (f: { taskId: string; severity: number; createdTick: number }) => [f.taskId, f.severity, f.createdTick];
        expect(naive.faults.map(key)).toEqual(crew.arienRuns[i].faults.map(key));
      });
    }
    // And the same faults at every crew size.
    expect(cmp.crews[0].naiveRuns[0].faults.map((f) => f.createdTick)).toEqual(cmp.crews[1].naiveRuns[0].faults.map((f) => f.createdTick));
  });

  it("the faults-detected row is the same for both and carries no verdict", () => {
    for (const crew of cmp.crews) {
      const row = crew.rows.find((r) => r.metric.key === "faults")!;
      expect(row.naive).toBe(row.arien);
      expect(row.judgement.verdict).toBe("n/a");
    }
  });

  it("detected = fixed + still open, for both dispatchers", () => {
    for (const crew of cmp.crews) {
      const get = (key: string, who: "naive" | "arien") => crew.rows.find((r) => r.metric.key === key)![who]!;
      for (const who of ["naive", "arien"] as const) expect(get("completed", who) + get("unfinished", who)).toBeCloseTo(get("faults", who), 9);
    }
  });

  it("Arien never loses work to a shift ending or strands the drone, and matches the log", () => {
    for (const crew of cmp.crews) {
      for (const run of crew.arienRuns) {
        expect(run.cutOffJobs).toBe(0);
        expect(run.strandings).toBe(0);
      }
    }
  });

  it("pairs seeds in order: the per-seed values judged are the runs' own", () => {
    const crew = cmp.crews[0];
    const metric = METRICS.find((m) => m.key === "completed")!;
    const row = crew.rows.find((r) => r.metric.key === "completed")!;
    expect(row.judgement).toEqual(judge(crew.naiveRuns.map(metric.perRun), crew.arienRuns.map(metric.perRun), metric.better, metric.unit));
  });
});

describe("comparison options", () => {
  it("a lighter fault rate means fewer faults", () => {
    const base = runComparison({ ...QUICK, techCounts: [1], seeds: [1] });
    const light = runComparison({ ...QUICK, techCounts: [1], seeds: [1], faultScale: 0.25 });
    const faults = (c: Comparison) => c.crews[0].rows.find((r) => r.metric.key === "faults")!.naive!;
    expect(faults(light)).toBeLessThan(faults(base) / 2);
    expect(faults(light)).toBeGreaterThan(0);
  });

  it("rejects a bad fault scale, and defaults are the documented ones", () => {
    expect(() => runComparison({ ...QUICK, faultScale: 0 })).toThrow(/faultScale/);
    expect(DEFAULT_COMPARE).toMatchObject({ seeds: [1, 2, 3, 4, 5], techCounts: [1, 2, 4], days: 3 });
  });
});
