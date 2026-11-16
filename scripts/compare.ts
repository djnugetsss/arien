// Runs the naive dispatcher and Arien's on the same seeds at several crew sizes and prints
// one comparison table. Deterministic: same options, same table, same checksum.
//   npm run compare                              5 seeds, 1 / 2 / 4 technicians, 3 sim days
//   npm run compare -- --days 1 --seeds 1,2      a quicker run
//   npm run compare -- --battery unlimited       ablation: the drone's battery never limits it
//   npm run compare -- --fault-scale 0.25         a quarter of the demo fault rate (a lighter load)
import { DEFAULT_COMPARE, runComparison, seedToUint32, type BatteryMode, type ComparisonRow, type Judgement, type Unit } from "../engine";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const list = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);
const seeds = arg("seeds") ? list(arg("seeds")!).map((s) => (/^-?\d+$/.test(s) ? Number(s) : s)) : DEFAULT_COMPARE.seeds;
const techCounts = arg("techs") ? list(arg("techs")!).map(Number) : DEFAULT_COMPARE.techCounts;
const days = arg("days") ? Number(arg("days")) : DEFAULT_COMPARE.days;
const battery = (arg("battery") ?? "default") as BatteryMode;
const faultScale = arg("fault-scale") ? Number(arg("fault-scale")) : 1;
if (![...techCounts, days].every((n) => Number.isInteger(n) && n >= 1) || (battery !== "default" && battery !== "unlimited") || !(faultScale > 0)) {
  console.error("Usage: npm run compare -- [--days N] [--seeds 1,2,3] [--techs 1,2,4] [--battery default|unlimited] [--fault-scale 0.25]");
  process.exit(1);
}

const cmp = runComparison({ seeds, techCounts, days, battery, faultScale });

// ---------- formatting ----------

function cell(value: number | null, unit: Unit): string {
  if (value === null) return "-";
  switch (unit) {
    case "percent":
      return `${(value * 100).toFixed(0)}%`;
    case "count":
      return value.toFixed(1);
    default:
      return value.toFixed(1);
  }
}

function verdictCell(j: Judgement): string {
  switch (j.verdict) {
    case "win":
      return `win ${j.better}/${j.seeds}`;
    case "lose":
      return `LOSE ${j.worse}/${j.seeds}`;
    case "tie":
      return "tie";
    case "mixed":
      return `mixed +${j.better}/-${j.worse}`;
    default:
      return "";
  }
}

const LABEL = 36;
const NUM = 7;
const RES = 13;
const pad = (s: string, n: number) => s.padStart(n);
const lines: string[] = [];
const out = (line = "") => lines.push(line);

const colsWidth = NUM + 1 + NUM + 2 + RES;
out(
  `${"".padEnd(LABEL)}${cmp.crews.map((c) => `  ${`${c.techs} technician${c.techs === 1 ? "" : "s"}`.padEnd(colsWidth)}`).join("")}`,
);
out(`${"".padEnd(LABEL)}${cmp.crews.map(() => `  ${pad("naive", NUM)} ${pad("arien", NUM)}  ${"result".padEnd(RES)}`).join("")}`);
out("-".repeat(LABEL + cmp.crews.length * (colsWidth + 2)));

let group = "";
cmp.crews[0].rows.forEach((row0, i) => {
  if (row0.metric.group !== group) {
    group = row0.metric.group;
    out(group);
  }
  const rows: ComparisonRow[] = cmp.crews.map((c) => c.rows[i]);
  out(
    `  ${row0.metric.label.padEnd(LABEL - 2)}${rows
      .map((r) => `  ${pad(cell(r.naive, r.metric.unit), NUM)} ${pad(cell(r.arien, r.metric.unit), NUM)}  ${verdictCell(r.judgement).padEnd(RES)}`)
      .join("")}`,
  );
});

out("-".repeat(LABEL + cmp.crews.length * (colsWidth + 2)));
const tally = (v: string) => cmp.crews.map((c) => `${c.rows.filter((r) => r.judgement.verdict === v).length}`.padStart(2)).join(" / ");
out(`Rows judged, per crew size (${cmp.crews.map((c) => c.techs).join(" / ")} technicians):`);
out(`  Arien wins  ${tally("win")}     ties  ${tally("tie")}     loses  ${tally("lose")}     mixed  ${tally("mixed")}`);

// ---------- print ----------

const faultsPerRun = cmp.crews[0].naiveRuns.map((r) => r.faults.length);
console.log("Arien vs naive dispatcher");
console.log(
  `seeds ${seeds.map((s) => JSON.stringify(s)).join(", ")}  |  ${days} sim days per run (${cmp.ticks} ticks)  |  drone battery: ${battery}  |  fault rate x${faultScale}  |  faults per run: ${faultsPerRun.join(", ")}`,
);
console.log("Both dispatchers face identical faults on each seed. Numbers are averages per run, except waits and times, which pool every fault across seeds.");
console.log("Wait = detection to fixed; a fault still open at the end is charged its wait so far. Result = Arien vs naive, seed by seed (win/LOSE need 4 of 5 seeds).\n");
for (const line of lines) console.log(line);
console.log(`\nchecksum ${seedToUint32(lines.join("\n")).toString(16).padStart(8, "0")}`);
