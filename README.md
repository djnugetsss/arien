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
```
# arien
