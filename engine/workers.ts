// Generic workers. A drone, a ground robot, a technician, a drone vendor, or an
// inspection crew are all the same shape: type, speed, skills, shift, position.
// Behavior comes from the fields (battery, shift, travel), never from the type label.
// Workers are immutable: every function returns a new worker.

import { elapsedSeconds, type Clock } from "./clock";

export interface Point {
  /** Meters east of the site origin. */
  x: number;
  /** Meters north of the site origin. */
  y: number;
}

export const SKILLS = ["inspect", "verify", "repair", "replace", "recover"] as const;
export type Skill = (typeof SKILLS)[number];

/** A label for people to read. The engine does not branch on it. */
export type WorkerType = "drone" | "ground_robot" | "technician" | (string & {});

/** "air" flies straight. "ground" travels along x, then along y. */
export type TravelMode = "air" | "ground";

/** Daily working window in sim hours (0 to 24). endHour < startHour means it runs past midnight. */
export interface Shift {
  startHour: number;
  endHour: number;
}

export interface Battery {
  /** Seconds of activity on a full charge. */
  capacityS: number;
  /** Seconds of activity left right now. */
  chargeS: number;
  /** Seconds at home to go from empty to full. */
  rechargeS: number;
}

export type WorkerStatus =
  | "idle" // free, on shift
  | "moving" // heading to its target
  | "charging" // at home, battery not full (can still be sent out)
  | "off_shift" // outside its shift: heads home and stays there
  | "stranded"; // battery died away from home: stuck until recovered

export interface Worker {
  id: string;
  name: string;
  type: WorkerType;
  travel: TravelMode;
  speedMps: number;
  skills: readonly Skill[];
  /** A person. People always get a conclusive result when they verify a fault. */
  human: boolean;
  /** null = available around the clock. */
  shift: Shift | null;
  /** null = no battery limit modeled. */
  battery: Battery | null;
  /** Depot or dock. Where it charges and where it goes off shift. */
  home: Point;
  position: Point;
  target: Point | null;
  status: WorkerStatus;
}

export interface WorkerSpec {
  id: string;
  name?: string;
  type: WorkerType;
  travel: TravelMode;
  speedMps: number;
  skills: readonly Skill[];
  human?: boolean;
  shift?: Shift | null;
  /** Starts fully charged. */
  battery?: { capacityS: number; rechargeS: number } | null;
  home?: Point;
  /** Defaults to home. */
  position?: Point;
}

// ASSUMPTION: the depot sits at the site's south-west corner.
export const DEFAULT_HOME: Point = { x: 0, y: 0 };

export function createWorker(spec: WorkerSpec): Worker {
  if (!(spec.speedMps > 0)) throw new Error(`${spec.id}: speedMps must be > 0, got ${spec.speedMps}`);
  if (spec.skills.length === 0) throw new Error(`${spec.id}: needs at least one skill`);
  const shift = spec.shift ?? null;
  if (shift) {
    const ok = (h: number) => h >= 0 && h <= 24;
    if (!ok(shift.startHour) || !ok(shift.endHour) || shift.startHour === shift.endHour) {
      throw new Error(`${spec.id}: bad shift ${shift.startHour} to ${shift.endHour}`);
    }
  }
  if (spec.battery && !(spec.battery.capacityS > 0 && spec.battery.rechargeS > 0)) {
    throw new Error(`${spec.id}: battery capacityS and rechargeS must be > 0`);
  }
  const home = spec.home ?? DEFAULT_HOME;
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    type: spec.type,
    travel: spec.travel,
    speedMps: spec.speedMps,
    skills: [...spec.skills],
    human: spec.human ?? false,
    shift,
    battery: spec.battery ? { ...spec.battery, chargeS: spec.battery.capacityS } : null,
    home: { ...home },
    position: { ...(spec.position ?? home) },
    target: null,
    status: "idle",
  };
}

type Overrides = Partial<Omit<WorkerSpec, "id">>;

/** Finds faults from the air. Limited by battery. */
export function createDrone(id: string, overrides: Overrides = {}): Worker {
  return createWorker({
    id,
    type: "drone",
    travel: "air",
    speedMps: 5, // ASSUMPTION: slow inspection flight speed
    skills: ["inspect"],
    shift: null, // ASSUMPTION: drone-in-a-box, can fly any hour
    battery: {
      capacityS: 25 * 60, // ASSUMPTION: 25 minutes of flight per charge
      rechargeS: 60 * 60, // ASSUMPTION: 60 minutes to recharge from empty
    },
    ...overrides,
  });
}

/** Checks faults up close. */
export function createGroundRobot(id: string, overrides: Overrides = {}): Worker {
  return createWorker({
    id,
    type: "ground_robot",
    travel: "ground",
    speedMps: 1, // ASSUMPTION: slow rover pace
    skills: ["verify"],
    shift: null, // ASSUMPTION: runs any hour
    battery: null, // ASSUMPTION: battery lasts a full day, so no limit modeled yet
    ...overrides,
  });
}

/** Repairs what robots cannot. Limited by shift. */
export function createTechnician(id: string, overrides: Overrides = {}): Worker {
  return createWorker({
    id,
    type: "technician",
    travel: "ground",
    speedMps: 1.4, // ASSUMPTION: normal walking pace
    skills: ["verify", "repair", "replace", "recover"], // recover = fetch a stranded drone or robot
    human: true,
    shift: { startHour: 8, endHour: 16 }, // ASSUMPTION: one 8-hour day shift
    battery: null,
    ...overrides,
  });
}

// ---------- geometry ----------

export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Travel distance in meters. Air is a straight line.
 * ASSUMPTION: ground workers can cross between panel rows anywhere, so ground
 * distance is |dx| + |dy|. Real sites only let you cross at row ends.
 */
export function travelDistance(travel: TravelMode, from: Point, to: Point): number {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return travel === "air" ? Math.hypot(dx, dy) : dx + dy;
}

export function travelSeconds(worker: Worker, to: Point, from: Point = worker.position): number {
  return travelDistance(worker.travel, from, to) / worker.speedMps;
}

function moveToward(travel: TravelMode, from: Point, to: Point, maxDistance: number): Point {
  const distance = travelDistance(travel, from, to);
  if (distance <= maxDistance) return { ...to }; // land exactly on the target, no float drift
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (travel === "air") {
    const share = maxDistance / distance;
    return { x: from.x + dx * share, y: from.y + dy * share };
  }
  const stepX = Math.min(Math.abs(dx), maxDistance);
  const stepY = Math.min(Math.abs(dy), maxDistance - stepX);
  return { x: from.x + Math.sign(dx) * stepX, y: from.y + Math.sign(dy) * stepY };
}

// ---------- shift ----------

const DAY_S = 24 * 3600;

export function isOnShift(shift: Shift | null, clock: Clock): boolean {
  return shiftSecondsLeft(shift, clock) > 0;
}

/** Seconds until the current shift ends. 0 when off shift. Infinity when there is no shift. */
export function shiftSecondsLeft(shift: Shift | null, clock: Clock): number {
  if (!shift) return Infinity;
  const now = elapsedSeconds(clock) % DAY_S;
  const start = shift.startHour * 3600;
  const end = shift.endHour * 3600;
  if (start < end) return now >= start && now < end ? end - now : 0;
  // Runs past midnight.
  if (now >= start) return DAY_S - now + end;
  return now < end ? end - now : 0;
}

/** Seconds until the next shift starts. 0 when on shift or when there is no shift. */
export function secondsUntilShiftStart(shift: Shift | null, clock: Clock): number {
  if (!shift || shiftSecondsLeft(shift, clock) > 0) return 0;
  const now = elapsedSeconds(clock) % DAY_S;
  const start = shift.startHour * 3600;
  return start > now ? start - now : DAY_S - now + start;
}

// ---------- questions the dispatcher will ask ----------

export function hasSkill(worker: Worker, skill: Skill): boolean {
  return worker.skills.includes(skill);
}

/** On shift and not stranded. */
export function isAvailable(worker: Worker, clock: Clock): boolean {
  return worker.status !== "stranded" && isOnShift(worker.shift, clock);
}

// ASSUMPTION: keep 20% of the battery in reserve when planning a trip.
export const DEFAULT_BATTERY_RESERVE = 0.2;

/** Enough charge to reach `to`, work there for `workSeconds`, and get home with the reserve intact? */
export function batteryAllowsTrip(
  worker: Worker,
  to: Point,
  workSeconds = 0,
  reserve: number = DEFAULT_BATTERY_RESERVE,
): boolean {
  if (!worker.battery) return true;
  const needed = travelSeconds(worker, to) + workSeconds + travelSeconds(worker, worker.home, to);
  return worker.battery.chargeS >= needed + reserve * worker.battery.capacityS;
}

/** Enough shift left to reach `to` and work there for `workSeconds`? */
export function shiftAllowsTrip(worker: Worker, clock: Clock, to: Point, workSeconds = 0): boolean {
  return shiftSecondsLeft(worker.shift, clock) >= travelSeconds(worker, to) + workSeconds;
}

// ---------- commands ----------

/** Give the worker a destination. It starts moving on the next tick. */
export function sendTo(worker: Worker, target: Point): Worker {
  if (worker.status === "stranded") throw new Error(`${worker.id} is stranded and cannot be sent anywhere`);
  if (samePoint(worker.position, target)) return { ...worker, target: null };
  return { ...worker, target: { ...target } };
}

/** A person fetched a stranded worker: back at home with an empty battery, charging. */
export function recoverWorker(worker: Worker): Worker {
  if (worker.status !== "stranded") return worker;
  return { ...worker, position: { ...worker.home }, target: null, status: "charging" };
}

// ---------- tick ----------

/**
 * Advances one worker by one tick. `clock` is the clock at the tick being simulated.
 *
 * Shift: off shift, the worker drops its target and heads home.
 * Battery: drains every second the worker is moving or away from home, and
 * recharges at home. If it hits zero away from home, the worker is stranded.
 */
export function stepWorker(worker: Worker, clock: Clock): Worker {
  if (worker.status === "stranded") return worker;

  const dt = clock.tickSeconds;
  const offShift = !isOnShift(worker.shift, clock);
  const startedAtHome = samePoint(worker.position, worker.home);

  let target = worker.target;
  if (offShift) target = startedAtHome ? null : worker.home;

  // A battery can run out partway through a tick.
  const battery = worker.battery;
  // Flat at home: it cannot take off. It charges this tick and keeps its target for later.
  const grounded = battery !== null && battery.chargeS <= 0 && startedAtHome;
  const heldTarget = grounded ? target : null;
  if (grounded) target = null;
  const active = target !== null || !startedAtHome;
  const usableS = battery && active ? Math.min(dt, battery.chargeS) : dt;

  let position = worker.position;
  let travelUsedS = 0;
  if (target) {
    travelUsedS = Math.min(usableS, travelSeconds(worker, target));
    position = moveToward(worker.travel, position, target, worker.speedMps * usableS);
    if (samePoint(position, target)) target = null;
  }
  const atHome = samePoint(position, worker.home);

  let nextBattery = battery;
  if (battery) {
    if (active) {
      // Reached home this tick: only the trip drained it. Otherwise it was out the whole tick.
      const drainS = atHome ? travelUsedS : usableS;
      nextBattery = { ...battery, chargeS: Math.max(0, battery.chargeS - drainS) };
    } else {
      const gain = (dt * battery.capacityS) / battery.rechargeS;
      nextBattery = { ...battery, chargeS: Math.min(battery.capacityS, battery.chargeS + gain) };
    }
  }

  if (grounded) target = heldTarget;

  let status: WorkerStatus;
  if (grounded && !offShift) {
    status = "charging";
  } else if (nextBattery && nextBattery.chargeS <= 0 && !atHome) {
    status = "stranded";
    target = null;
  } else if (offShift) {
    status = "off_shift";
  } else if (target) {
    status = "moving";
  } else if (nextBattery && atHome && nextBattery.chargeS < nextBattery.capacityS) {
    status = "charging";
  } else {
    status = "idle";
  }

  return { ...worker, position, target, battery: nextBattery, status };
}

export function stepWorkers(workers: readonly Worker[], clock: Clock): Worker[] {
  return workers.map((worker) => stepWorker(worker, clock));
}
