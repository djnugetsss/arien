// Runs the headless sim and prints every task state change.
//   npm run sim                  seed "arien-demo", 1,000 ticks
//   npm run sim -- 42 2000       seed 42, 2,000 ticks
//   npm run sim -- 42 1000 all   also print assigned / arrived / released lines
import { TASK_STATES, formatEvent, formatSimTime, runSim, seedToUint32 } from "../engine";

const [seedArg = "arien-demo", ticksArg = "1000", mode = ""] = process.argv.slice(2);
const seed = /^-?\d+$/.test(seedArg) ? Number(seedArg) : seedArg;
const ticks = Number(ticksArg);
if (!Number.isInteger(ticks) || ticks < 1) {
  console.error(`ticks must be a whole number >= 1, got "${ticksArg}"`);
  process.exit(1);
}

const sim = runSim({ seed, ticks });
const shown = sim.events.filter((e) => mode === "all" || e.kind === "state" || e.kind === "detected" || e.kind === "released");
const lines = sim.events.map((e) => formatEvent(e, sim));

console.log(`Arien sim  seed=${JSON.stringify(seed)}  ticks=${ticks}  ends ${formatSimTime(sim.clock)}  dispatcher=first-free`);
console.log(`crew: ${sim.workers.map((w) => `${w.id} (${w.type})`).join(", ")}\n`);
for (const e of shown) console.log(formatEvent(e, sim));

const byState = TASK_STATES.map((s) => `${s}=${sim.tasks.filter((t) => t.state === s).length}`).join("  ");
const done = sim.tasks.filter((t) => t.doneTick !== null);
const avgDone = done.length ? Math.round(done.reduce((sum, t) => sum + (t.doneTick! - t.createdTick), 0) / done.length) : 0;
console.log(`\n${sim.tasks.length} tasks  ${byState}`);
console.log(`done in avg ${avgDone} ticks  released=${sim.events.filter((e) => e.kind === "released").length}`);
console.log(`workers at end: ${sim.workers.map((w) => `${w.id}=${w.status}`).join("  ")}`);
console.log(`checksum ${seedToUint32(lines.join("\n")).toString(16).padStart(8, "0")}`);
