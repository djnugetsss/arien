// Tick clock. Sim time is a tick counter, never wall-clock time.
// Clocks are immutable: advancing returns a new one, which keeps playback simple.

export interface Clock {
  /** Ticks since the start of the run. Starts at 0. */
  tick: number;
  /** Sim seconds that one tick represents. */
  tickSeconds: number;
}

export const DEFAULT_TICK_SECONDS = 60; // ASSUMPTION: 1 tick = 1 sim minute; tune once worker speeds exist

export function createClock(tickSeconds: number = DEFAULT_TICK_SECONDS): Clock {
  if (!(tickSeconds > 0)) throw new Error(`tickSeconds must be > 0, got ${tickSeconds}`);
  return { tick: 0, tickSeconds };
}

export function advance(clock: Clock, ticks = 1): Clock {
  if (!Number.isInteger(ticks) || ticks < 0) throw new Error(`Can only advance by a whole number of ticks >= 0, got ${ticks}`);
  return { ...clock, tick: clock.tick + ticks };
}

export function elapsedSeconds(clock: Clock): number {
  return clock.tick * clock.tickSeconds;
}

/** Sim time as "D+HH:MM", e.g. tick 1500 at 60s/tick -> "1+01:00". */
export function formatSimTime(clock: Clock): string {
  const totalMinutes = Math.floor(elapsedSeconds(clock) / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hh = String(Math.floor((totalMinutes % 1440) / 60)).padStart(2, "0");
  const mm = String(totalMinutes % 60).padStart(2, "0");
  return `${days}+${hh}:${mm}`;
}
