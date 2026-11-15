// Runs the headless sim and prints the decision log: every decision with its why.
//   npm run sim                        seed "arien-demo", one sim day (8,640 ticks), Arien dispatcher
//   npm run sim -- 42 20000            seed 42, 20,000 ticks
//   npm run sim -- 42 8640 naive       the naive baseline
//   npm run sim -- 42 8640 arien all   also print events (handoffs, state changes) between decisions
import { arienDispatcher, formatDecision, formatEvent, formatSimTime, naiveDispatcher, runSim, seedToUint32, TASK_STATES } from "../engine";

const [seedArg = "arien-demo", ticksArg = "8640", dispatcherArg = "arien", mode = ""] = process.argv.slice(2);
const seed = /^-?\d+$/.test(seedArg) ? Number(seedArg) : seedArg;
const ticks = Number(ticksArg);
if (!Number.isInteger(ticks) || ticks < 1) {
  console.error(`ticks must be a whole number >= 1, got "${ticksArg}"`);
  process.exit(1);
}
if (dispatcherArg !== "arien" && dispatcherArg !== "naive") {
  console.error(`dispatcher must be "arien" or "naive", got "${dispatcherArg}"`);
  process.exit(1);
}

const sim = runSim({ seed, ticks, dispatcher: dispatcherArg === "naive" ? naiveDispatcher : arienDispatcher });

// Decisions and events, in the order they happened.
const lines: Array<{ tick: number; order: number; text: string }> = [];
sim.decisions.forEach((d, i) => lines.push({ tick: d.tick, order: i, text: formatDecision(d, sim.clock) }));
if (mode === "all") sim.events.forEach((e, i) => lines.push({ tick: e.tick, order: -1e9 + i, text: formatEvent(e, sim.clock) }));
lines.sort((a, b) => a.tick - b.tick || a.order - b.order);

console.log(`Arien sim  seed=${JSON.stringify(seed)}  ticks=${ticks}  ends ${formatSimTime(sim.clock)}  dispatcher=${dispatcherArg}`);
console.log(`crew: ${sim.workers.map((w) => `${w.id} (${w.type})`).join(", ")}\n`);
for (const line of lines) console.log(line.text);

const count = <T extends string>(items: T[]) => {
  const totals = new Map<T, number>();
  for (const item of items) totals.set(item, (totals.get(item) ?? 0) + 1);
  return [...totals].map(([k, n]) => `${k}=${n}`).join("  ");
};
const faultTasks = sim.tasks.filter((t) => t.kind === "fault");
const missingWhy = sim.decisions.filter((d) => !d.why || !d.rule).length;
const failed = sim.events.filter((e) => e.kind === "handoff_failed");

console.log(`\n${faultTasks.length} fault tasks  ${TASK_STATES.map((s) => `${s}=${faultTasks.filter((t) => t.state === s).length}`).join("  ")}`);
console.log(`resolutions: ${count(sim.tasks.flatMap((t) => (t.resolution ? [t.resolution] : []))) || "none"}`);
console.log(`decisions: ${sim.decisions.length}  ${count(sim.decisions.map((d) => d.kind))}`);
console.log(`failed handoffs: ${failed.length}  ${count(failed.map((e) => (e.kind === "handoff_failed" ? e.reason : "")))}`);
console.log(`escalations: ${sim.escalations.length}  ${count(sim.escalations.map((e) => e.level))}`);
console.log(`workers at end: ${sim.workers.map((w) => `${w.id}=${w.status}`).join("  ")}`);
console.log(`decisions without a reason: ${missingWhy}`);
console.log(`checksum ${seedToUint32(lines.map((l) => l.text).join("\n")).toString(16).padStart(8, "0")}`);
