// Prints the fault log for one run.
//   npm run faults                 seed "arien-demo", one sim day (8,640 ticks)
//   npm run faults -- 42           seed 42
//   npm run faults -- storm 5000   seed "storm", 5,000 ticks
import { FAULT_TYPES, createClock, createSite, formatFault, runFaultLog, seedToUint32 } from "../engine";

const [seedArg = "arien-demo", ticksArg = "8640"] = process.argv.slice(2);
const seed = /^-?\d+$/.test(seedArg) ? Number(seedArg) : seedArg;
const ticks = Number(ticksArg);
if (!Number.isInteger(ticks) || ticks < 1) {
  console.error(`ticks must be a whole number >= 1, got "${ticksArg}"`);
  process.exit(1);
}

const site = createSite();
const clock = createClock();
const faults = runFaultLog({ seed, ticks, site });
const lines = faults.map((fault) => formatFault(fault, clock));

console.log(`Arien fault log  seed=${JSON.stringify(seed)}  ticks=${ticks}  site=${site.rows}x${site.panelsPerRow}  tick=${clock.tickSeconds}s`);
console.log("time     tick        id     type           sev    location");
for (const line of lines) console.log(line);

const counts = FAULT_TYPES.map((type) => `${type}=${faults.filter((f) => f.type === type).length}`).join("  ");
// Same seed and ticks always give the same checksum. Compare two runs at a glance.
const checksum = seedToUint32(lines.join("\n")).toString(16).padStart(8, "0");
console.log(`\n${faults.length} faults  ${counts}`);
console.log(`checksum ${checksum}`);
