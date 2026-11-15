// The headline guarantee: same seed, same run. Uses rng + site + clock together
// the way the fault generator will: each tick, maybe pick a panel.
import { describe, expect, it } from "vitest";
import { advance, createClock, createRng, createSite, formatSimTime, type Seed } from "./index";

function runLog(seed: Seed, ticks = 1000): string[] {
  const rng = createRng(seed);
  const site = createSite();
  let clock = createClock();
  const log: string[] = [];
  for (let i = 0; i < ticks; i++) {
    clock = advance(clock);
    if (rng.chance(0.05)) {
      const panel = rng.pick(site.panels);
      log.push(`${formatSimTime(clock)} tick=${clock.tick} panel=${panel.id}`);
    }
  }
  return log;
}

describe("determinism across rng + site + clock", () => {
  it("same seed gives a byte-identical 1,000-tick log", () => {
    const a = runLog("arien-demo");
    const b = runLog("arien-demo");
    expect(a.length).toBeGreaterThan(0);
    expect(a.join("\n")).toBe(b.join("\n"));
  });

  it("a different seed gives a different log", () => {
    expect(runLog(1).join("\n")).not.toBe(runLog(2).join("\n"));
  });

  it("holds for many seeds", () => {
    for (let seed = 0; seed < 50; seed++) expect(runLog(seed, 200)).toEqual(runLog(seed, 200));
  });
});
