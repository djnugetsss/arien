# Arien

Coordination engine for mixed solar maintenance crews. Starts as a simulation.
Rules and phases live in `CLAUDE.md`.

## Layout

- `engine/`: pure TypeScript sim (world, workers, tasks, dispatcher, metrics). No React.
- `scenarios/`: JSON site and fault setups.
- `app/`: Next.js dashboard (App Router).
- `docs/`: notes.

## Run

```bash
npm install
npm run dev        # app at http://localhost:3000
npm test           # engine tests, headless, once
npm run test:watch # engine tests in watch mode
npm run typecheck  # tsc, no emit
npm run lint

npm run faults                        # fault log, one sim day, seed "arien-demo"
npm run sim                           # decision log with a why for every decision (Arien dispatcher)
npm run sim -- arien-demo 8640 naive  # same day, naive baseline
npm run sim -- 42 8640 arien all      # another seed, with handoff and state events too

npm run compare                       # naive vs Arien: 5 seeds x 1/2/4 technicians x 3 sim days, one table (about 25 s)
npm run compare -- --battery unlimited   # ablation: the drone's battery never limits either dispatcher
npm run compare -- --fault-scale 0.25    # a quarter of the demo fault rate (a lighter load)
npm run compare -- --days 1 --seeds 1,2  # quicker
```

One tick is 10 sim seconds, so a sim day is 8,640 ticks.
# arien
