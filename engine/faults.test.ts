import { describe, expect, it } from "vitest";
import { createRng } from "./rng";
import { createSite } from "./site";
import {
  DEFAULT_FAULT_CONFIG,
  FAULT_TYPES,
  createFaultGenerator,
  formatFault,
  formatLocation,
  runFaultLog,
  type Fault,
} from "./faults";

const site = createSite();
const log = (faults: Fault[]) => faults.map((f) => formatFault(f)).join("\n");

describe("fault generator: determinism", () => {
  it("same seed gives identical faults over 1,000 ticks", () => {
    const a = runFaultLog({ seed: "arien-demo", ticks: 1000 });
    const b = runFaultLog({ seed: "arien-demo", ticks: 1000 });
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("same seed gives a byte-identical printed log", () => {
    expect(log(runFaultLog({ seed: 42, ticks: 1000 }))).toBe(log(runFaultLog({ seed: 42, ticks: 1000 })));
  });

  it("different seeds give different logs", () => {
    expect(log(runFaultLog({ seed: 1, ticks: 1000 }))).not.toBe(log(runFaultLog({ seed: 2, ticks: 1000 })));
  });

  it("holds across many seeds", () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(runFaultLog({ seed, ticks: 500 })).toEqual(runFaultLog({ seed, ticks: 500 }));
    }
  });

  it("a longer run starts with the exact same faults as a shorter one", () => {
    const short = runFaultLog({ seed: 7, ticks: 400 });
    const long = runFaultLog({ seed: 7, ticks: 1000 });
    expect(long.slice(0, short.length)).toEqual(short);
  });

  it("stepping tick by tick matches runFaultLog", () => {
    const generator = createFaultGenerator(site, createRng(7));
    const stepped: Fault[] = [];
    for (let tick = 1; tick <= 1000; tick++) stepped.push(...generator.step(tick));
    expect(stepped).toEqual(runFaultLog({ seed: 7, ticks: 1000 }));
  });

  it("log for seed 42 is pinned, so a change to rates or draw order fails loudly", () => {
    expect(log(runFaultLog({ seed: 42, ticks: 300 }))).toMatchInlineSnapshot(`
      "0+00:05  tick=0005  F0001  string_outage  sev=2  R10-P21..P40
      0+01:03  tick=0063  F0002  hotspot        sev=1  R03-P38
      0+01:59  tick=0119  F0003  hotspot        sev=2  R14-P08
      0+02:23  tick=0143  F0004  hotspot        sev=4  R02-P04
      0+02:23  tick=0143  F0005  soiling        sev=2  R01-P03..P10
      0+02:23  tick=0143  F0006  tracker_stuck  sev=4  R09-P01..P40
      0+02:42  tick=0162  F0007  hotspot        sev=2  R15-P16
      0+03:13  tick=0193  F0008  tracker_stuck  sev=5  R17-P01..P40
      0+04:14  tick=0254  F0009  hotspot        sev=2  R17-P32"
    `);
  });
});

describe("fault generator: fault shape", () => {
  const faults = runFaultLog({ seed: "shape-check", ticks: 20_000 });

  it("produces all four fault types", () => {
    expect(new Set(faults.map((f) => f.type))).toEqual(new Set(FAULT_TYPES));
  });

  it("every fault has a valid severity, start tick, and on-grid location", () => {
    for (const f of faults) {
      expect([1, 2, 3, 4, 5]).toContain(f.severity);
      expect(f.startTick).toBeGreaterThanOrEqual(1);
      expect(f.startTick).toBeLessThanOrEqual(20_000);
      const { row, colStart, colEnd, x, y } = f.location;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(site.rows);
      expect(colStart).toBeGreaterThanOrEqual(0);
      expect(colEnd).toBeGreaterThanOrEqual(colStart);
      expect(colEnd).toBeLessThan(site.panelsPerRow);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(site.widthM);
      expect(y).toBeCloseTo(row * site.rowPitchM);
    }
  });

  it("ids are sequential and start ticks never go backwards", () => {
    faults.forEach((f, i) => {
      expect(f.id).toBe(`F${String(i + 1).padStart(4, "0")}`);
      if (i > 0) expect(f.startTick).toBeGreaterThanOrEqual(faults[i - 1].startTick);
    });
  });

  it("each type covers the right panels", () => {
    const { panelsPerString, soilingSpan } = DEFAULT_FAULT_CONFIG;
    for (const { type, location: loc } of faults) {
      const size = loc.colEnd - loc.colStart + 1;
      if (type === "hotspot") expect(size).toBe(1);
      if (type === "soiling") expect(size).toBeLessThanOrEqual(soilingSpan.max);
      if (type === "string_outage") {
        expect(loc.colStart % panelsPerString).toBe(0);
        expect(size).toBe(panelsPerString);
      }
      if (type === "tracker_stuck") expect(size).toBe(site.panelsPerRow);
    }
  });

  it("severity follows the weights: soiling is never 5, string outage is never 1", () => {
    expect(faults.some((f) => f.type === "soiling" && f.severity === 5)).toBe(false);
    expect(faults.some((f) => f.type === "string_outage" && f.severity === 1)).toBe(false);
    expect(new Set(faults.filter((f) => f.type === "hotspot").map((f) => f.severity)).size).toBe(5);
  });

  it("fault counts land near the configured rates", () => {
    for (const type of FAULT_TYPES) {
      const expected = DEFAULT_FAULT_CONFIG.perTickChance[type] * 20_000;
      const actual = faults.filter((f) => f.type === type).length;
      expect(actual).toBeGreaterThan(expected * 0.7);
      expect(actual).toBeLessThan(expected * 1.3);
    }
  });
});

describe("fault generator: config and formatting", () => {
  const off = { hotspot: 0, soiling: 0, string_outage: 0, tracker_stuck: 0 };

  it("zero rates give no faults", () => {
    expect(runFaultLog({ seed: 1, ticks: 1000, config: { perTickChance: off } })).toEqual([]);
  });

  it("one type can be switched on alone", () => {
    const faults = runFaultLog({ seed: 1, ticks: 200, config: { perTickChance: { ...off, tracker_stuck: 1 } } });
    expect(faults).toHaveLength(200);
    expect(faults.every((f) => f.type === "tracker_stuck")).toBe(true);
  });

  it("works on a small site", () => {
    const small = createSite({ rows: 2, panelsPerRow: 5 });
    for (const f of runFaultLog({ seed: 3, ticks: 5000, site: small })) {
      expect(f.location.row).toBeLessThan(2);
      expect(f.location.colEnd).toBeLessThan(5);
    }
  });

  it("rejects bad config", () => {
    const make = (config: Parameters<typeof createFaultGenerator>[2]) => () => createFaultGenerator(site, createRng(1), config);
    expect(make({ perTickChance: { ...off, hotspot: 1.5 } })).toThrow();
    expect(make({ soilingSpan: { min: 5, max: 2 } })).toThrow();
    expect(make({ panelsPerString: 0 })).toThrow();
  });

  it("formats locations and log lines", () => {
    expect(formatLocation({ row: 6, colStart: 11, colEnd: 11, x: 0, y: 0 })).toBe("R07-P12");
    expect(formatLocation({ row: 6, colStart: 11, colEnd: 19, x: 0, y: 0 })).toBe("R07-P12..P20");
    const line = formatFault({ id: "F0003", type: "hotspot", severity: 3, startTick: 192, location: { row: 6, colStart: 11, colEnd: 11, x: 0, y: 0 } });
    expect(line).toBe("0+03:12  tick=0192  F0003  hotspot        sev=3  R07-P12");
  });
});
