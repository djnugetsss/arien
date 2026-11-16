# Phase 3 dispatcher spec

Status: built Nov 15, 2026 with all 12 picks as written. Code is in `engine/dispatcher.ts`, `engine/decisions.ts` and `engine/sim.ts`; tests in `engine/dispatcher.test.ts`. The last section lists where the build differs from this spec.

Everything here is rule-based and deterministic: same seed and same human inputs give the same run. No LLM makes a decision. Every number is an `// ASSUMPTION` until a practitioner checks it.

**One ground rule for the whole phase:** the two dispatchers (Arien and the naive baseline) only differ in their decisions. Faults, outcomes, travel, batteries, shifts and failure physics are identical for both. Otherwise the phase 4 comparison is rigged.

Decisions I'm unsure about are marked **PICK** with the option I'd go with. They're collected in the last section.

## 1. How tasks get scored

Each tick, every waiting task gets a priority score. Highest score is served first.

```
priority = 20 × severity                      (20 to 100)
         + min(60, age in minutes ÷ 6)        (10 points per hour, capped at 60)
         + type bonus                         (tracker_stuck 15, string_outage 10, hotspot 5, soiling 0)
         + 20 if the task was interrupted     (a worker dropped it mid-step)
```

- **Severity** dominates. One severity level is worth two hours of waiting.
- **Wait time** is counted from when the fault was detected, not from when the current step started, because total fault wait is the metric we report. The cap stops an old sev-1 from ever beating a fresh sev-5 (max 20 + 60 + 15 = 95 vs 100). Tasks that wait too long are handled by escalation (section 5), not by an ever-growing score.
- **Fault type** is a small flat bonus for faults that take out more panels.
- **Location** does not change a task's score. It matters in two places: who gets sent (section 2), and as a near-tie breaker: if two tasks a worker could take are within 10 points of each other, the worker takes the closer one.
- **Ties** break by higher severity, then older, then lower task id. Always in that order.

All score parts are whole numbers so the "why" log can show the sum exactly.

## 2. How a worker is chosen

Tasks are handled greedily in score order: the top task picks its best worker, then the next task picks from who's left.

**Step 1: filter.** A worker is a candidate only if all of these hold. Each failed check is recorded as the reject reason.

| Check | Rule | Engine helper |
| --- | --- | --- |
| Capability | has the skill for this step | `hasSkill` |
| Available | on shift, not stranded, not on another task | `isAvailable`, busy set |
| Not failed here | has not already failed this step on this task | new: `task.failedWorkerIds` |
| Battery left | can fly there, do the work, and get home with 20% in reserve | `batteryAllowsTrip` |
| Shift left | can get there and finish the work before the shift ends | `shiftAllowsTrip` |

**Step 2: rank the candidates.**

1. **Specialist first:** the worker with the fewest skills wins. The robot verifies before a technician does, so technicians stay free for repairs.
2. **Earliest arrival:** shortest travel time from where the worker is now.
3. **Most slack:** more battery or shift time left after the job.
4. **Crew order,** as a final fixed tie-break.

**Technician guard:** a technician is only offered a verify job if no repair or replace job is waiting that they could take.

**No preemption:** a worker who has been assigned keeps the job, even if a more severe fault appears. Only a human override can pull them off.

**Charging:** an idle drone goes home and charges (the sim already does this). It goes back out as soon as the battery check passes for the top inspect task. If it can't go yet, that's logged once as a hold: "D1 needs 6 more minutes of charge".

## 3. Handoff model

A handoff is the moment a task finishes one step and needs a different worker for the next. It passes information, not a physical object: the drone doesn't wait on site for the robot.

There are three handoffs per task:

| Handoff | From → to |
| --- | --- |
| Pickup | detection → drone (inspect) |
| Confirm | drone → ground robot (verify) |
| Fix | robot → technician (repair or replace) |

Each one produces explicit events:

1. `handoff_offered`: step finished, next step needs a worker. Carries a packet: fault type, severity, location, age, what the last worker found.
2. `handoff_accepted`: a worker is assigned, with an expected arrival time.
3. `handoff_completed`: that worker arrives and starts work.
4. `handoff_failed`: with a reason (below).

**Deadline.** Every handoff must be accepted within a time limit set by severity:

| Severity | 5 | 4 | 3 | 2 | 1 |
| --- | --- | --- | --- | --- | --- |
| Accept within | 15 min | 30 min | 60 min | 2 h | 4 h |

Once accepted, the worker must arrive within their expected travel time plus 5 minutes.

**A failed handoff is one of:**

- **Timed out:** nobody capable accepted before the deadline.
- **Dropped:** the worker who accepted went stranded or off shift before arriving.
- **Late:** the worker didn't arrive within travel time plus 5 minutes.
- **Bounced:** the receiving worker arrived but couldn't do the step (the robot can't confirm, section 4b).

**Response:** a dropped, late or bounced handoff gets one automatic retry with the next-best worker. A timeout, or a failed retry, escalates. Failed handoffs are counted for the phase 4 metric.

## 4. Failure cases

| Case | How it's detected | Automatic response | Escalates? |
| --- | --- | --- | --- |
| **a. Drone battery dies mid-flight** | drone status becomes `stranded` | Task is released back to waiting with its age and a +20 interrupted bonus. A recovery job is created for a technician: walk to the drone, 10 min on site, drone goes home empty and charges. | Yes, right away (fleet is down a drone). |
| **b. Robot can't confirm** | robot finishes verify with result "unconfirmed" | Handoff bounces. Robot is added to the task's failed list. Task goes to a technician for a second verify. | Only if no technician picks it up before the deadline. |
| **c. No technician on shift** | a job needs a technician and none is on shift | Task waits. Logged once as a hold: "waits for T1, shift starts 08:00". | Only if the next shift start is past the task's deadline. Then one digest for all such tasks, not one each. |
| **d. Handoff times out** | deadline in section 3 passes | None, there's nobody to retry with. | Yes. |
| **e. Technician shift ends mid-repair** | technician goes `off_shift` while working | Task is released with the +20 bonus so it's first in line next shift. Progress on that step is lost. | Only if severity is 4 or 5. |

Notes on each:

- **(a)** Arien's battery check should stop this from ever happening on its own decisions. It can still happen after a human override, and it happens to the naive baseline. Recovery needs a new `recover` skill on the technician.
- **(b)** Whether the robot can confirm a fault is decided when the fault appears, from the outcomes random stream, the same way repair-or-replace already is. That keeps it independent of the dispatcher. Chance: 15% of faults. A technician's verify is always conclusive: either confirmed (carries on to repair or replace) or a false alarm (30% of unconfirmed ones), which closes the task as `done` with resolution `false_alarm`. No new task state is needed, just a `resolution` field: `repaired`, `replaced` or `false_alarm`.
- **(c)** Escalating every overnight task the moment it's queued would bury the inbox. A sev-1 found at 22:00 has a 4-hour deadline, so it escalates at 02:00 in the digest, not at 22:00.
- **(e)** Arien avoids this by never starting a job that can't finish in the shift. So like (a), this mostly shows up in the baseline and after overrides.

## 5. Escalation to a human

**What triggers one:**

| Trigger | Level |
| --- | --- |
| A worker is stranded | urgent |
| A handoff timed out, or failed its retry | needs decision |
| A task passed its deadline with no worker on the way | needs decision |
| No worker in the whole crew has the skill a task needs | needs decision, immediate |
| A sev 4–5 repair was cut off by shift end | needs decision |
| A new severity-5 fault appeared | notice only, no action needed |

One open escalation per task. Tasks stuck for the same reason are grouped into one digest.

**What the human is shown:**

- **Headline:** one line, such as "Sev 4 string outage at R12 has waited 47 min for a technician".
- **Why it escalated:** the trigger and the rule that fired.
- **The task:** fault type, severity, location, age, current step, and its timeline so far.
- **What was tried:** the assignments, retries and reject reasons from the why log.
- **Options,** each with a predicted result computed by the same rules:
  - **Approve** the suggested action, for example "send T2, arrives 08:03, done about 09:05".
  - **Reassign** to a worker the human picks. This can break the soft rules (specialist-first, technician guard) but not capability.
  - **Take over:** the human handles it outside the system and marks the result.
  - **Wait:** snooze until a set time, such as shift start.
- **Default and timer:** what happens if nobody responds, and when.

All of this is structured data, so the inbox works with no LLM. Later, the Claude API can turn the same record into a friendlier paragraph. It never picks the option.

**Keeping runs repeatable.** A human in the loop breaks determinism unless their actions are recorded. So:

- Every human action is an event with a tick. Replaying those events on the same seed reproduces the run.
- Headless runs use an **auto-human**: a fixed policy that approves the suggested action 10 minutes after the escalation opens. Both dispatchers get the same auto-human.

## 6. The "why" log

Every decision produces one structured record. The printed line is rendered from it.

```ts
{
  tick: 287,
  kind: "assign",          // assign | hold | handoff | retry | release | escalate | override
  rule: "ASSIGN_SPECIALIST_NEAREST",
  taskId: "T0009",
  workerId: "G1",
  score: { total: 95, severity: 80, wait: 5, type: 10, interrupted: 0 },
  considered: [
    { workerId: "G1", ok: true,  travelS: 48 },
    { workerId: "T1", ok: false, reject: "off shift until 08:00" },
  ],
}
```

Rendered:

```
0+04:47  tick=0287  T0009  assign  G1 → verify
  why: score 95 (sev 80 + wait 5 + type 10). G1 chosen: only free verifier, 48 s away.
       Skipped T1: off shift until 08:00.
```

Rules:

- **Every decision has a rule id** from a fixed list, so you can count how often each rule fires.
- **Holds are decisions too.** "Nobody can take this yet" gets a record with the reason. It's logged when the reason first applies and again only when it changes, not every tick.
- **The score always shows its parts,** and the parts add up to the total.
- **Rejected candidates are listed with one reason each:** the first check they failed.
- **Human overrides are logged the same way,** with `kind: "override"` and what they replaced.

## 7. Naive baseline

The comparison target is "a whiteboard and a radio": someone handing out jobs in the order they came in, to whoever's free.

- **Task order:** oldest first. Severity, fault type and location are ignored.
- **Worker choice:** the first free worker in crew order who has the skill and is on shift.
- **No look-ahead:** no battery check, no shift-end check, no distance check, no technician guard.
- **Failures:** a released or bounced task goes back in the queue at its original place. No retry logic, no deadlines.
- **Escalation:** only when a worker is stranded. It gets the same auto-human and the same recovery job as Arien.

This is `firstFreeDispatcher` as it exists today, plus the recovery job. It still logs a "why" for every assignment ("first free worker with verify").

It's deliberately weak but not a strawman: it can recover from every failure, just slowly and without planning. If it could never get its drone back, the comparison would prove nothing.

## What has to change in the engine

- **Dispatcher output:** from a list of assignments to a list of decisions (assign, hold, escalate), each with a why record.
- **Task fields:** `failedWorkerIds`, `robotCanConfirm`, `resolution`, `interrupted`, and the current handoff's deadline.
- **New events:** the four handoff events, `hold`, `escalated`, `resolved`, `override`.
- **Workers:** a `recover` skill for technicians and a recovery job type.
- **Auto-human policy** for headless runs.
- **Tick length:** see pick 1.

Suggested build order: engine changes above with tests → Arien dispatcher scoring and worker choice → handoffs and deadlines → failure cases one at a time → escalations and auto-human → `npm run sim` prints every decision with its why.

## Decisions I'm unsure about

| # | Question | Options | My pick | Why |
| --- | --- | --- | --- | --- |
| 1 | Tick length | 60 s (today) or 10 s | **10 s** | At 60 s every worker crosses the site in one or two ticks, so distance and arrival deadlines mean nothing. Costs: sim times in the fault log shift, and 1,000 ticks covers 2.8 h instead of 16.7 h, so demo runs need about 6,000 ticks. |
| 2 | Wait-time score | capped at 60, or uncapped | **Capped** | A fresh sev-5 always wins. Old low-severity tasks are caught by deadlines instead. |
| 3 | Fault-type weight | flat bonus per type, or scaled by panels affected | **Flat** | Easier to explain and tune. Severity already carries most of the impact. |
| 4 | Worker ranking | specialist first, or nearest first | **Specialist first** | The naive run showed tasks pile up waiting for the one technician. On a site this small, distance is worth seconds; technician time is worth hours. |
| 5 | Matching | greedy by score, or best overall pairing | **Greedy** | Explainable in one sentence. An optimal matcher is hard to write a "why" for. |
| 6 | Preemption | never, only while traveling, or always | **Never** in v0 | Avoids thrash and lost work. A human can still reassign. Worth revisiting if sev-5 response time looks bad in phase 4. |
| 7 | Progress when a worker drops a job | lost, or kept | **Lost** | Already built, and the conservative choice. A practitioner should tell us if a half-done repair really restarts. |
| 8 | Jobs that won't fit in the shift | don't start, or start and hand over | **Don't start** | Follows from pick 7: starting means throwing the work away. |
| 9 | False alarms | include, or every fault is real | **Include,** as a `resolution` on `done` | "Robot can't confirm" needs a real outcome, and false alarms are the most believable one. No new task state. |
| 10 | Overnight tasks with no technician | escalate at once, or only past the deadline | **Past the deadline, as one digest** | Otherwise the inbox fills every night with things nobody can act on. |
| 11 | How weak the baseline is | never recovers, or same safety net | **Same safety net** | A baseline that loses its drone forever makes the comparison meaningless to a practitioner. |
| 12 | Drone recovery | human just clicks, or a technician job | **Technician job** | It costs technician time in the real world, so it should cost it in the sim. |

Two things I left out on purpose, for later: paid overtime to finish a job at shift end, and merging overlapping faults (a hotspot on a row whose tracker is also stuck) into one visit.

## As built: differences from this spec

1. **Technician guard is narrower.** As written, a technician never verified while any repair was waiting. In a busy run that left faults the robot had already failed with nobody allowed to check them, forever. Now the guard only counts repair jobs the technician could finish this shift, and it is off when no verify-only worker is left for the task.
2. **The naive baseline leaves a charging drone on its charger until full.** Without this, a drone fetched with a dead battery was relaunched at once, died again, and the baseline never inspected anything. That is the strawman section 7 says to avoid. It still makes no check that the battery will last the trip.
3. **A flat battery at home charges first.** A drone at home with zero charge and a job used to sit there forever, neither charging nor leaving. That was a bug in the worker model, fixed for both dispatchers.
4. **All timeouts are grouped into digests,** not only the "nobody on shift" ones. Tasks past their deadline waiting for the same skill share one escalation.
5. **One extra why-log kind: `resolve`.** A person approving a suggestion or saying "wait" is logged as `resolve`. `override` is kept for reassign and take over, where the person goes against the rules.
6. **Fault rates were rescaled for 10-second ticks** so faults per sim hour are unchanged (about 39 per sim day).
7. **A `human` flag on workers** marks people. Only a person's verify is always conclusive. The engine still never branches on the worker type label.
8. **`injectFault()`** places a specific fault by hand. Tests use it now; crew mode will need it.

9. **Escalations are raised once per stuck situation, not once per deadline.** The first build re-raised a task every time a snooze ended, because a snooze reset the handoff deadline and the timeout fired again. Fixed (section 5 now reads as follows):
   - A task remembers what it looked like when it was last escalated: its step, severity, failure count and blocker.
   - It is raised again only when **severity changes**, it suffers **another failed handoff**, its **blocker gets worse** (for example every worker who can take it goes off shift), or **8 hours pass with no change** (`reminderAfterS`, `// ASSUMPTION`).
   - **Blockers only count when they get worse.** capacity (busy, low battery) is the mildest, then nobody on shift, then nobody in the crew has the skill. A shift starting is good news and raises nothing.
   - A **new step** is a new situation, so a task can be raised once per step it gets stuck on.
   - **A snooze ending raises nothing.** It only moves the reminder clock: the reminder counts 8 h from the end of the snooze. A snooze never touches the handoff.
   - **A handoff times out at most once** between being offered and being accepted.
   - Tasks that got stuck the same way at the same moment (a shift ending, a reminder round) share one escalation.
   - The suggestion for a plain timeout is now "keep it queued, reminder in 8 h", which needs no snooze. "Wait for the shift" is still suggested when everyone is off shift.
   - New rules: `ESCALATE_SITUATION_CHANGED` and `REMIND_STILL_WAITING`.

10. **Review fixes (Nov 15).**
    - **Nobody left who can do the step** is its own blocker and escalates at once (`ESCALATE_NOBODY_LEFT`). Before, a fault the robot could not confirm, in a crew with no person, waited out its deadline and then got a generic "keep it queued".
    - **Shift fit is counted in whole ticks.** Counted in raw seconds, a job whose work time was not a whole number of ticks could be started and then cut off one tick after the shift ended.
    - **"Still waiting" escalations are dropped for a task that gets its worker on the same tick.** A failed retry or a cut-off repair is still raised.
    - **A timeout is never hidden behind a leftover shift-cut alert.**
    - **Straight-line distance uses `sqrt`, not `Math.hypot`,** and a guardrail test bans Math functions that can differ between JS engines.

Open questions from the review, not yet decided:

- **Battery model for the baseline.** Over 5 seeds x 3 days with three technicians, the naive baseline strands its drone 18 times and the drone is out of action about 37% of the time. Real drones fly home by themselves on low battery, so a practitioner may read that gap as rigged. Proposal: make low-battery return-to-home part of the physics for both dispatchers and drop the "wait for full charge" special case.
- **Section 5 is only partly built.** Options carry labels but no predicted result, and Arien never suggests "send X" as the action to approve.
- **Open escalations do not close when the task moves on.** They stay in the inbox until answered.
- **The technician guard ignores severity.** A severity-5 fault waiting for a busy robot is not verified by a free technician if any repair that fits is waiting.

Known and left for phase 4:

- **The inbox is still busy when the crew is overloaded.** One technician and about 39 faults a day means many tasks are genuinely stuck. They are now each raised once per step, not repeatedly.
- **The stand-in human only ever acknowledges or says "wait".** It cannot add capacity, so it does not change outcomes. It only keeps the inbox moving.
