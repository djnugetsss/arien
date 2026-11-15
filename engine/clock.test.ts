import { describe, expect, it } from "vitest";
import { advance, createClock, elapsedSeconds, formatSimTime } from "./clock";

describe("tick clock", () => {
  it("starts at tick 0", () => {
    expect(createClock().tick).toBe(0);
  });

  it("advances by one tick by default, or by n", () => {
    const c = createClock();
    expect(advance(c).tick).toBe(1);
    expect(advance(c, 250).tick).toBe(250);
    expect(advance(advance(c, 3), 4).tick).toBe(7);
  });

  it("does not mutate the clock it was given", () => {
    const c = createClock();
    advance(c, 10);
    expect(c.tick).toBe(0);
  });

  it("converts ticks to sim time", () => {
    const c = advance(createClock(60), 1500);
    expect(elapsedSeconds(c)).toBe(90_000);
    expect(formatSimTime(c)).toBe("1+01:00");
    expect(formatSimTime(createClock())).toBe("0+00:00");
  });

  it("1,000 single ticks land exactly where one 1,000-tick jump does", () => {
    let c = createClock();
    for (let i = 0; i < 1000; i++) c = advance(c);
    expect(c).toEqual(advance(createClock(), 1000));
  });

  it("rejects bad input", () => {
    expect(() => createClock(0)).toThrow();
    expect(() => advance(createClock(), -1)).toThrow();
    expect(() => advance(createClock(), 1.5)).toThrow();
  });
});
