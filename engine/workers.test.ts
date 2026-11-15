import { describe, expect, it } from "vitest";
import { advance, createClock, type Clock } from "./clock";
import { createRng } from "./rng";
import { createSite } from "./site";
import {
  batteryAllowsTrip,
  createDrone,
  createGroundRobot,
  createTechnician,
  createWorker,
  hasSkill,
  isAvailable,
  isOnShift,
  recoverWorker,
  sendTo,
  shiftAllowsTrip,
  shiftSecondsLeft,
  stepWorker,
  stepWorkers,
  travelDistance,
  travelSeconds,
  type Worker,
} from "./workers";

const TICK_S = 5;
/** Clock at a given sim hour, 5-second ticks. */
const at = (hour: number): Clock => advance(createClock(TICK_S), Math.round((hour * 3600) / TICK_S));
const NOON = at(12);

/** Steps a worker n ticks, starting from `clock`. Returns the worker and the final clock. */
function run(worker: Worker, n: number, clock: Clock = NOON): { worker: Worker; clock: Clock } {
  for (let i = 0; i < n; i++) {
    clock = advance(clock);
    worker = stepWorker(worker, clock);
  }
  return { worker, clock };
}

describe("workers: the three presets", () => {
  const drone = createDrone("D1");
  const robot = createGroundRobot("G1");
  const tech = createTechnician("T1");

  it("all share one shape: type, speed, skills, shift, position", () => {
    for (const w of [drone, robot, tech]) {
      expect(w.speedMps).toBeGreaterThan(0);
      expect(w.skills.length).toBeGreaterThan(0);
      expect(w.position).toEqual(w.home);
      expect(w.status).toBe("idle");
      expect(w.target).toBeNull();
    }
    expect([drone.type, robot.type, tech.type]).toEqual(["drone", "ground_robot", "technician"]);
  });

  it("drone inspects, robot verifies, technician repairs", () => {
    expect(hasSkill(drone, "inspect")).toBe(true);
    expect(hasSkill(drone, "repair")).toBe(false);
    expect(hasSkill(robot, "verify")).toBe(true);
    expect(hasSkill(robot, "repair")).toBe(false);
    expect(hasSkill(tech, "repair")).toBe(true);
    expect(hasSkill(tech, "replace")).toBe(true);
  });

  it("only the drone has a battery, only the technician has a shift", () => {
    expect(drone.battery).not.toBeNull();
    expect(drone.battery!.chargeS).toBe(drone.battery!.capacityS);
    expect(robot.battery).toBeNull();
    expect(tech.battery).toBeNull();
    expect(drone.shift).toBeNull();
    expect(robot.shift).toBeNull();
    expect(tech.shift).toEqual({ startHour: 8, endHour: 16 });
  });

  it("other crews fit the same model", () => {
    const vendor = createWorker({
      id: "V1",
      name: "Drone vendor crew",
      type: "drone_vendor",
      travel: "ground",
      speedMps: 1.4,
      skills: ["inspect"],
      shift: { startHour: 9, endHour: 13 },
    });
    expect(vendor.type).toBe("drone_vendor");
    expect(isOnShift(vendor.shift, at(10))).toBe(true);
    expect(isOnShift(vendor.shift, at(14))).toBe(false);
  });

  it("rejects bad specs", () => {
    const base = { id: "X", type: "x", travel: "ground", skills: ["verify"], speedMps: 1 } as const;
    expect(() => createWorker({ ...base, speedMps: 0 })).toThrow();
    expect(() => createWorker({ ...base, skills: [] })).toThrow();
    expect(() => createWorker({ ...base, shift: { startHour: 8, endHour: 8 } })).toThrow();
    expect(() => createWorker({ ...base, shift: { startHour: 8, endHour: 25 } })).toThrow();
    expect(() => createWorker({ ...base, battery: { capacityS: 0, rechargeS: 10 } })).toThrow();
  });
});

describe("workers: movement", () => {
  it("covers speed x tick length each tick", () => {
    const robot = sendTo(createGroundRobot("G1"), { x: 40, y: 0 }); // 1 m/s, 5 s ticks
    const { worker } = run(robot, 3);
    expect(worker.position).toEqual({ x: 15, y: 0 });
    expect(worker.status).toBe("moving");
  });

  it("arrives exactly on the target, then goes idle", () => {
    const robot = sendTo(createGroundRobot("G1"), { x: 12, y: 0 });
    const almost = run(robot, 2).worker;
    expect(almost.position).toEqual({ x: 10, y: 0 });
    const there = run(robot, 3).worker;
    expect(there.position).toEqual({ x: 12, y: 0 }); // no overshoot to 15
    expect(there.target).toBeNull();
    expect(there.status).toBe("idle");
  });

  it("stays put with no target", () => {
    const robot = createGroundRobot("G1", { position: { x: 7, y: 7 } });
    expect(run(robot, 50).worker.position).toEqual({ x: 7, y: 7 });
  });

  it("drone flies a straight line", () => {
    const drone = sendTo(createDrone("D1"), { x: 30, y: 40 }); // 50 m away, 25 m per tick
    const mid = run(drone, 1).worker;
    expect(mid.position.x).toBeCloseTo(15);
    expect(mid.position.y).toBeCloseTo(20);
    expect(run(drone, 2).worker.position).toEqual({ x: 30, y: 40 });
  });

  it("ground workers go along x first, then y", () => {
    const tech = sendTo(createTechnician("T1"), { x: 10, y: 20 }); // 1.4 m/s = 7 m per tick
    expect(run(tech, 1).worker.position).toEqual({ x: 7, y: 0 });
    const turn = run(tech, 2).worker.position; // 3 m of x left, then 4 m of y
    expect(turn.x).toBe(10);
    expect(turn.y).toBeCloseTo(4);
    expect(run(tech, 5).worker.position).toEqual({ x: 10, y: 20 }); // 30 m at 7 m per tick
  });

  it("travel time matches the ticks it actually takes", () => {
    const site = createSite();
    const far = { x: site.widthM, y: site.heightM };
    for (const w of [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1")]) {
      const ticks = Math.ceil(travelSeconds(w, far) / TICK_S);
      const sent = sendTo(w, far);
      expect(run(sent, ticks - 1).worker.status).toBe("moving");
      expect(run(sent, ticks).worker.position).toEqual(far);
    }
  });

  it("air distance is straight, ground distance is x plus y", () => {
    expect(travelDistance("air", { x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(travelDistance("ground", { x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7);
  });

  it("can be redirected mid-trip", () => {
    const robot = run(sendTo(createGroundRobot("G1"), { x: 100, y: 0 }), 2).worker;
    const back = run(sendTo(robot, { x: 0, y: 0 }), 2).worker;
    expect(back.position).toEqual({ x: 0, y: 0 });
    expect(back.status).toBe("idle");
  });

  it("does not mutate the worker it was given", () => {
    const robot = sendTo(createGroundRobot("G1"), { x: 40, y: 0 });
    const snapshot = JSON.stringify(robot);
    run(robot, 5);
    expect(JSON.stringify(robot)).toBe(snapshot);
  });
});

describe("workers: drone battery", () => {
  // Small battery so the numbers are easy to follow: 60 s of flight, 120 s to recharge.
  const smallDrone = (extra = {}) => createDrone("D1", { battery: { capacityS: 60, rechargeS: 120 }, ...extra });

  it("drains while flying", () => {
    const drone = run(sendTo(smallDrone(), { x: 500, y: 0 }), 4).worker;
    expect(drone.battery!.chargeS).toBe(40);
  });

  it("drains while hovering away from home", () => {
    const drone = run(sendTo(smallDrone(), { x: 25, y: 0 }), 5).worker; // arrives on tick 1, hovers 4 more
    expect(drone.position).toEqual({ x: 25, y: 0 });
    expect(drone.battery!.chargeS).toBe(35);
  });

  it("does not drain sitting at home", () => {
    expect(run(smallDrone(), 100).worker.battery!.chargeS).toBe(60);
  });

  it("is stranded when the battery dies away from home", () => {
    const { worker } = run(sendTo(smallDrone(), { x: 500, y: 0 }), 12); // 60 s of charge = 12 ticks
    expect(worker.status).toBe("stranded");
    expect(worker.battery!.chargeS).toBe(0);
    expect(worker.target).toBeNull();
    expect(worker.position).toEqual({ x: 300, y: 0 }); // 60 s at 5 m/s, and not a meter more
  });

  it("only flies as far as the last of its charge allows", () => {
    const drone = createDrone("D1", { battery: { capacityS: 12, rechargeS: 120 } }); // dies 2 s into tick 3
    const { worker } = run(sendTo(drone, { x: 500, y: 0 }), 3);
    expect(worker.position).toEqual({ x: 60, y: 0 }); // 12 s x 5 m/s
    expect(worker.status).toBe("stranded");
  });

  it("a stranded drone stays stranded, does not move, and cannot be sent", () => {
    const stranded = run(sendTo(smallDrone(), { x: 500, y: 0 }), 12).worker;
    const later = run(stranded, 100).worker;
    expect(later).toEqual(stranded);
    expect(() => sendTo(stranded, { x: 0, y: 0 })).toThrow();
    expect(isAvailable(stranded, NOON)).toBe(false);
  });

  it("recovery puts it back home, empty and charging", () => {
    const stranded = run(sendTo(smallDrone(), { x: 500, y: 0 }), 12).worker;
    const recovered = recoverWorker(stranded);
    expect(recovered.position).toEqual(recovered.home);
    expect(recovered.status).toBe("charging");
    expect(run(recovered, 24).worker.battery!.chargeS).toBe(60); // 120 s to full
    expect(run(recovered, 24).worker.status).toBe("idle");
  });

  it("recharges at home and never above capacity", () => {
    // Out 4 ticks, back 4 ticks: 40 s used, 20 s left.
    const out = run(sendTo(smallDrone(), { x: 100, y: 0 }), 4).worker;
    const home = run(sendTo(out, out.home), 4).worker;
    expect(home.position).toEqual(home.home);
    expect(home.battery!.chargeS).toBe(20);
    expect(run(home, 1).worker.status).toBe("charging");
    expect(run(home, 8).worker.battery!.chargeS).toBe(40); // 5 s tick adds 2.5 s of charge
    const full = run(home, 500).worker;
    expect(full.battery!.chargeS).toBe(60);
    expect(full.status).toBe("idle");
  });

  it("landing at home mid-tick only drains the flight time used", () => {
    const out = createDrone("D1", { battery: { capacityS: 60, rechargeS: 120 }, position: { x: 10, y: 0 } });
    const home = run(sendTo(out, out.home), 1).worker; // 10 m at 5 m/s = 2 s
    expect(home.battery!.chargeS).toBe(58);
  });

  it("making it home on the last second is not stranded", () => {
    const drone = createDrone("D1", { battery: { capacityS: 10, rechargeS: 120 }, position: { x: 50, y: 0 } });
    const home = run(sendTo(drone, drone.home), 2).worker;
    expect(home.position).toEqual(home.home);
    expect(home.battery!.chargeS).toBe(0);
    expect(home.status).toBe("charging");
  });

  it("can be sent out again while charging", () => {
    const charging = recoverWorker(run(sendTo(smallDrone(), { x: 500, y: 0 }), 12).worker);
    const topped = run(charging, 10).worker; // 25 s of charge
    expect(run(sendTo(topped, { x: 50, y: 0 }), 1).worker.status).toBe("moving");
  });

  it("batteryAllowsTrip checks the round trip plus work plus reserve", () => {
    const drone = smallDrone(); // 60 s, 5 m/s, default 20% reserve = 12 s
    expect(batteryAllowsTrip(drone, { x: 100, y: 0 })).toBe(true); // 40 s round trip + 12 s reserve
    expect(batteryAllowsTrip(drone, { x: 100, y: 0 }, 10)).toBe(false); // + 10 s of work = 62 s
    expect(batteryAllowsTrip(drone, { x: 150, y: 0 }, 0, 0)).toBe(true); // exactly 60 s, no reserve
    expect(batteryAllowsTrip(drone, { x: 150, y: 0 })).toBe(false);
    expect(batteryAllowsTrip(createGroundRobot("G1"), { x: 9999, y: 9999 })).toBe(true); // no battery modeled
  });

  it("a trip batteryAllowsTrip approves really does get home", () => {
    const drone = smallDrone();
    const dest = { x: 100, y: 0 };
    expect(batteryAllowsTrip(drone, dest)).toBe(true);
    const there = run(sendTo(drone, dest), 4).worker;
    const back = run(sendTo(there, there.home), 4).worker;
    expect(back.position).toEqual(back.home);
    expect(back.status).not.toBe("stranded");
  });
});

describe("workers: technician shift", () => {
  const tech = createTechnician("T1"); // 08:00 to 16:00

  it("is on shift from start hour up to, not including, end hour", () => {
    expect(isOnShift(tech.shift, at(7.99))).toBe(false);
    expect(isOnShift(tech.shift, at(8))).toBe(true);
    expect(isOnShift(tech.shift, at(15.99))).toBe(true);
    expect(isOnShift(tech.shift, at(16))).toBe(false);
    expect(isOnShift(tech.shift, at(0))).toBe(false);
  });

  it("repeats every day", () => {
    expect(isOnShift(tech.shift, at(24 + 9))).toBe(true);
    expect(isOnShift(tech.shift, at(48 + 20))).toBe(false);
  });

  it("handles a night shift that runs past midnight", () => {
    const night = { startHour: 22, endHour: 6 };
    expect(isOnShift(night, at(23))).toBe(true);
    expect(isOnShift(night, at(3))).toBe(true);
    expect(isOnShift(night, at(6))).toBe(false);
    expect(isOnShift(night, at(12))).toBe(false);
    expect(shiftSecondsLeft(night, at(23))).toBe(7 * 3600);
    expect(shiftSecondsLeft(night, at(5))).toBe(3600);
  });

  it("no shift means always on", () => {
    expect(isOnShift(null, at(3))).toBe(true);
    expect(shiftSecondsLeft(null, at(3))).toBe(Infinity);
  });

  it("reports the seconds left in the shift", () => {
    expect(shiftSecondsLeft(tech.shift, at(15))).toBe(3600);
    expect(shiftSecondsLeft(tech.shift, at(8))).toBe(8 * 3600);
    expect(shiftSecondsLeft(tech.shift, at(17))).toBe(0);
  });

  it("is off_shift and unavailable outside the shift", () => {
    const night = run(tech, 1, at(2)).worker;
    expect(night.status).toBe("off_shift");
    expect(isAvailable(night, at(2))).toBe(false);
    expect(isAvailable(tech, at(10))).toBe(true);
  });

  it("drops the job and walks home when the shift ends", () => {
    const out = createTechnician("T1", { position: { x: 21, y: 0 } });
    const working = sendTo(out, { x: 40, y: 100 });
    const { worker: mid } = run(working, 1, at(16)); // shift just ended
    expect(mid.status).toBe("off_shift");
    expect(mid.target).toEqual(mid.home);
    expect(mid.position).toEqual({ x: 14, y: 0 }); // 7 m toward home, not toward the job
    const { worker: home } = run(working, 3, at(16));
    expect(home.position).toEqual(home.home);
    expect(home.target).toBeNull();
    expect(home.status).toBe("off_shift");
  });

  it("ignores orders while off shift", () => {
    const sent = sendTo(tech, { x: 40, y: 0 });
    const { worker } = run(sent, 10, at(20));
    expect(worker.position).toEqual(worker.home);
    expect(worker.status).toBe("off_shift");
  });

  it("is idle again when the next shift starts", () => {
    const { worker: before } = run(tech, 1, at(7.9));
    expect(before.status).toBe("off_shift");
    const { worker: after } = run(before, 1, at(8));
    expect(after.status).toBe("idle");
    expect(run(sendTo(after, { x: 14, y: 0 }), 2, at(8)).worker.position).toEqual({ x: 14, y: 0 });
  });

  it("shiftAllowsTrip checks travel plus work against the time left", () => {
    const dest = { x: 42, y: 0 }; // 30 s walk
    expect(shiftAllowsTrip(tech, at(15), dest, 3000)).toBe(true); // 3,030 s of 3,600 s left
    expect(shiftAllowsTrip(tech, at(15), dest, 3600)).toBe(false);
    expect(shiftAllowsTrip(tech, at(17), dest)).toBe(false);
    expect(shiftAllowsTrip(createGroundRobot("G1"), at(3), dest, 99_999)).toBe(true);
  });

  it("robots and drones keep working at night", () => {
    const robot = run(sendTo(createGroundRobot("G1"), { x: 10, y: 0 }), 2, at(2)).worker;
    expect(robot.position).toEqual({ x: 10, y: 0 });
    expect(robot.status).toBe("idle");
  });
});

describe("workers: determinism", () => {
  const site = createSite();

  /** A full crew wandering to seeded random panels for 1,000 ticks, starting 07:30. */
  function crewRun(seed: number | string): string[] {
    const rng = createRng(seed);
    let crew: Worker[] = [createDrone("D1"), createGroundRobot("G1"), createTechnician("T1")];
    let clock = at(7.5);
    const log: string[] = [];
    for (let i = 0; i < 1000; i++) {
      clock = advance(clock);
      crew = crew.map((w) => {
        if (w.status !== "idle" || !rng.chance(0.2)) return w;
        const panel = rng.pick(site.panels);
        return sendTo(w, { x: panel.x, y: panel.y });
      });
      crew = stepWorkers(crew, clock);
      log.push(crew.map((w) => `${w.id}:${w.status}@${w.position.x},${w.position.y}/${w.battery?.chargeS ?? "-"}`).join(" "));
    }
    return log;
  }

  it("same seed gives an identical 1,000-tick crew log", () => {
    const a = crewRun("crew-demo");
    expect(a.join("\n")).toBe(crewRun("crew-demo").join("\n"));
    expect(new Set(a).size).toBeGreaterThan(100); // the crew really moved
  });

  it("different seeds give different logs", () => {
    expect(crewRun(1).join("\n")).not.toBe(crewRun(2).join("\n"));
  });

  it("holds across many seeds", () => {
    for (let seed = 0; seed < 20; seed++) expect(crewRun(seed)).toEqual(crewRun(seed));
  });

  it("workers stay inside the site", () => {
    for (const line of crewRun("bounds")) {
      for (const part of line.split(" ")) {
        const [x, y] = part.split("@")[1].split("/")[0].split(",").map(Number);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(site.widthM + 1e-9);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(site.heightM + 1e-9);
      }
    }
  });
});
