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
  it("same seed gives identical faults over one sim day", () => {
    const a = runFaultLog({ seed: "arien-demo", ticks: 8640 });
    const b = runFaultLog({ seed: "arien-demo", ticks: 8640 });
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("same seed gives a byte-identical printed log", () => {
    expect(log(runFaultLog({ seed: 42, ticks: 8640 }))).toBe(log(runFaultLog({ seed: 42, ticks: 8640 })));
  });

  it("different seeds give different logs", () => {
    expect(log(runFaultLog({ seed: 1, ticks: 8640 }))).not.toBe(log(runFaultLog({ seed: 2, ticks: 8640 })));
  });

  it("holds across many seeds", () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(runFaultLog({ seed, ticks: 3000 })).toEqual(runFaultLog({ seed, ticks: 3000 }));
    }
  });

  it("a longer run starts with the exact same faults as a shorter one", () => {
    const short = runFaultLog({ seed: 7, ticks: 4000 });
    const long = runFaultLog({ seed: 7, ticks: 8640 });
    expect(short.length).toBeGreaterThan(0);
    expect(long.slice(0, short.length)).toEqual(short);
  });

  it("stepping tick by tick matches runFaultLog", () => {
    const generator = createFaultGenerator(site, createRng(7));
    const stepped: Fault[] = [];
    for (let tick = 1; tick <= 8640; tick++) stepped.push(...generator.step(tick));
    expect(stepped).toEqual(runFaultLog({ seed: 7, ticks: 8640 }));
  });

  it("log for seed 42 is pinned, so a change to rates or draw order fails loudly", () => {
    expect(log(runFaultLog({ seed: 42, ticks: 2000 }))).toMatchInlineSnapshot(`
      "0+00:24  tick=00145  F0001  soiling        sev=1  R02-P37..P39
      0+00:33  tick=00198  F0002  hotspot        sev=4  R17-P37
      0+01:44  tick=00626  F0003  hotspot        sev=4  R02-P26
      0+03:21  tick=01208  F0004  hotspot        sev=2  R13-P25
      0+03:24  tick=01224  F0005  hotspot        sev=3  R05-P03
      0+04:04  tick=01469  F0006  hotspot        sev=2  R08-P37
      0+05:28  tick=01973  F0007  hotspot        sev=3  R19-P16"
    `);
  });
});

describe("fault generator: fault shape", () => {
  const faults = runFaultLog({ seed: "shape-check", ticks: 200_000 });

  it("produces all four fault types", () => {
    expect(new Set(faults.map((f) => f.type))).toEqual(new Set(FAULT_TYPES));
  });

  it("every fault has a valid severity, start tick, and on-grid location", () => {
    for (const f of faults) {
      expect([1, 2, 3, 4, 5]).toContain(f.severity);
      expect(f.startTick).toBeGreaterThanOrEqual(1);
      expect(f.startTick).toBeLessThanOrEqual(200_000);
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
      const expected = DEFAULT_FAULT_CONFIG.perTickChance[type] * 200_000;
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
    expect(line).toBe("0+00:32  tick=00192  F0003  hotspot        sev=3  R07-P12");
  });
});
