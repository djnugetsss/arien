# Arien

Coordination engine for mixed crews (drones, ground robots, human technicians) on solar site maintenance. Starts as a simulation. Full context: "Physical-World Coordination Project Brief.md" in this folder. Read it before big decisions.

## What we're building (v0)
- One simulated solar site: grid of panel rows, about 20 rows x 40 panels.
- Generic workers: type, speed, skills, shift. Drone finds faults, ground robot verifies, technician repairs. Drone vendors and inspection crews fit the same model.
- Faults: hotspot, soiling, string outage, tracker stuck.
- Task states: detected -> inspect -> verify -> repair -> done (replace is a branch).
- Coordination layer: rule-based dispatcher (severity + wait time, nearest capable worker), explicit handoff events, escalation to a human. Failure cases are first-class: battery dies, robot can't confirm, no tech on shift, handoff times out.
- Metrics: fault wait time, failed handoffs, worker utilization.
- Dashboard: site map, task queue, escalation inbox, human override (approve/reassign/take over), playback and scrubbing.

## Rules
1. /engine is pure TypeScript. It never imports React or anything from /app.
2. The engine is deterministic. Seeded RNG only, same seed gives same run. No Math.random, no Date.now in the engine.
3. Dispatch decisions are rule-based, never an LLM call. The Claude API is only for explaining escalations to the human, later.
4. Every dispatch decision logs a short "why".
5. Any number that looks like real-world data gets a `// ASSUMPTION` comment. Never invent customers, prices, or traction.
6. Write engine tests before wiring UI. Tests run headless.
7. One phase per session. Every phase ends in a runnable state. If a phase stalls, ship it ugly and move on.
8. Out of scope for v0: auth, multi-site, real maps, real weather, hardware, landing page.

## Stack
Next.js, React, Tailwind, TypeScript. Supabase only when persistence is needed. Local state is fine for v0.

## Folders
- /engine: world, workers, tasks, dispatcher, metrics (pure TS)
- /scenarios: JSON site and fault setups
- /app: dashboard

## Phases
1. Site and world (engine only)
2. Workers and tasks
3. Coordination layer
4. Metrics and naive-vs-Arien comparison
5. Dashboard
6. Crew mode (user enters own crew and faults)
7. Scenarios and demo video
8. Pilot offer to outreach list

## Voice
Casual, plain. Short explanations. Tell me what you changed and how to run it.

## Design (must be beautiful)
- UI quality is a requirement. The dashboard and landing page share one design language.
- References: Viam, Hut 8, SpaceX. Borrow structure and tone (confident, minimal, big type, concrete numbers, one promise + one action above the fold), never layouts, wording, or brand elements. Build our own identity.
- All colors, type scale, spacing, and radii live in one design-tokens file. No hardcoded styles in components.
- Before building the dashboard: do a visual review of the three reference sites and write down what to borrow in /docs/design-notes.md.
- Dashboard should feel like a mission-control room: dark-first, high contrast, smooth live motion, nothing cluttered.
- Landing page (phase 5b) uses the same tokens: one promise, one action ("Try the simulation"), a three-stage story, real numbers from the comparison run.
