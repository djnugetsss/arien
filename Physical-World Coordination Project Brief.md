# Physical-World Coordination: Project Brief

Oct 23, 2026 · updated Nov 15, 2026 · @Ansh

## Start here

This brief carries the full context for a new conversation: Ansh is building Arien, software that coordinates AI agents, robots, and people on physical-world jobs, starting with solar farm maintenance in simulation. As of Nov 15 the plan changed: build now, and aim at a paid pilot.

- **Decision (Nov 15, replaces the Oct 23 plan):** build first instead of waiting on Gate A. Ansh wants to build something impressive, and profit is a priority. Outreach keeps running in the background, since those contacts become the demo audience and pilot prospects.
- **Goal:** a working demo that makes small and mid-size solar maintenance companies want a paid pilot. Credibility and a network still matter. Revenue is now a priority, not just a bonus.
- **Status:** a direction, not a business. Nobody has said they would pay. Outreach emails went to about 28 companies in Oct and Nov, and no replies have been reported yet.
- **Working name:** Arien. In Tolkien, the spirit who guides the sun across the sky each day. Chosen Oct 25, 2026 over Anor, Rigel, Corvo, Cael, Orro, and Ravel. Domains and trademarks are not checked (USPTO search, classes 9 and 42, plus a domain search). Tolkien names carry some risk from the Tolkien estate. Treat it as a working name until a paying customer exists.
- **Next step:** set up the repo and build the engine (phase 1 below), in Claude Code inside Cursor.
- **How Ansh likes to work:** a casual, plain voice. Honest answers, but not negative: help build what can be built. One clear recommendation instead of long option lists. A one-sentence summary when things get confusing. Claims backed by pages we actually read.

## The idea

We will build software that helps AI agents, robots, and people work together on physical-world jobs, starting in simulation with solar farm maintenance.

**Profit angle (Nov 15):** today's small and mid-size O&M companies run technicians, drone vendors, and inspection crews. Robots come later. So the engine uses generic workers, and the first sellable version is a dispatch board for mixed crews: it takes faults from inspections, assigns the nearest capable tech or vendor, tracks handoffs, and flags anything waiting too long. The simulation is the demo and the proof. The board is what someone pays for.

## Where things stand

We have a direction, not a revenue source: nobody has said they would pay for this.

**Decided so far**

- Ream, the medical-records tool, is shelved. The repo and site stay up and can be revived later.
- The field is software at the meeting point of AI agents, robots, and human workers (the idea behind item #8 on YC's Fall 2026 list).
- Solar farm maintenance is the first setting. Wind turbines and data centers are later settings. Farms are last.
- On October 25, 2026, Ansh said this is what he plans to work on for the foreseeable future.
- **Nov 15:** build now. The original rule "no code before Gate A" is dropped by choice. Gates A, B, and C still exist as checks on whether the work is leading anywhere.
- **Nov 15:** skip YC W27. The Nov 2 deadline passed.
- **Nov 15:** the business-side work (outreach, selling, company setup) felt like too much solo, so the build comes first and outreach runs in the background.
- Build happens in Claude Code inside Cursor, in a repo at `/Users/anshmehta/arien`.

**Still a hypothesis**

- That solar operators have a coordination problem they would pay to fix.
- That small and mid-size firms will pay for a crew dispatch board before they run many robots.
- That a solo builder can make a simulation that practitioners find believable.
- That building on or next to an existing platform such as Viam would open doors, which has not been checked.
- That Raptor Maps does not already cover this. Its own site claims to "orchestrate field work done across human and robotic workers" and has a technician mobile app. We only read marketing copy, so the real depth is unverified.

## Realistic goals

| Horizon | What counts as success | How likely |
| --- | --- | --- |
| Next few weeks | Engine and sim running, a dashboard with human override, a "before vs. after" comparison on the same seed | Very doable |
| 3 to 6 months | A demo and write-up people in the field actually look at, and one company giving real feedback time or running a paid pilot | Plausible, not guaranteed |
| About a year | Known in a small niche as the person who built this, maybe one or a few small paying customers | Best case. A real company with a team would be a stretch |

We have no price data and will not invent any. The first real pricing information is what people say they pay for similar tools today.

## Constraints and what already exists

Ansh builds alone on nights and weekends, with hours that swing a lot from week to week, and already has a working web stack from Ream.

- **Time:** solo, nights and weekends, hours vary a lot. Each phase is sized by what is done, not by hours.
- **Skills and stack:** Next.js, React, Tailwind, and the Claude API. Supabase only when persistence is needed. Local state is fine for v0.
- **Spend:** close to zero. The simulation needs no hardware.
- **Dislikes:** AI wrappers, and heavy compliance costs like the HIPAA and BAA path that ended Ream.
- **Assets:** the Ream repo and site (shelved, still live), a concept mock of a cluster "flight simulator" from an earlier idea at [this private link](https://claude.ai/artifact/9zQmj3qYrjpWvMmanUr8op), a Notion outreach tracker with about 28 companies, and seven Gmail drafts.
- **Design taste:** Viam and Hut 8 are the premium references (see the design section below).

## How we got here

Ansh narrowed a dozen ideas to this one by testing each against three questions: is it genuinely useful, is it not an AI wrapper, and can one person start it on nights and weekends.

| Idea | What it was | Why it was set aside or kept |
| --- | --- | --- |
| Ream | Medical records turned into legal chronologies for injury law firms | Shelved. It felt like a wrapper around the model, and the compliance costs (HIPAA and BAA) looked too heavy. |
| Cluster flight simulator | A simulator for AI cluster network and optical failures, with incident replay | A concept mock was built. Set aside to find a more solid idea first, and Ansh did not want the idea built around one family contact's expertise. |
| Capacity exchange | An AI marketplace for network capacity between data centers | The coolest idea Ansh had seen in a while, but unrealistic for now. |
| Environments for network-ops AI agents | Practice problems and graders for AI that troubleshoots networks | A real market, but crowded with many sellers and unclear buyers. Not pursued. |
| Fields scanned | Open-source robotics, AI interpretability tools, clean energy, earth observation, neurotech | Robotics and clean energy fit best. The last two had thin evidence. |
| YC Fall 2026 list | 13 requests for startups | Ansh liked #5 (offshore compute), #8 (physical-world operating system, his top pick), #10 (physical-world data), and #12 (compliance). He chose #8 because he saw no major competitor and it felt new and exciting. |
| Settings for #8 | Solar, wind, data centers, farms | Solar chosen: easy to simulate, reachable customers, room for a newcomer. Wind and data centers come later. Farms ranked last. |

## Why this, why now

Clean energy is being built faster than the people and systems that keep it running, and robots and AI agents are starting to fill that gap.

- **Lots of new capacity.** Solar and storage made up 91% of new US capacity in Q1 2026, and the EIA expects a record 86 GW of utility-scale additions in 2026 ([pv magazine](https://pv-magazine-usa.com/2026/07/10/grid-operators-make-interconnection-progress-but-solar-and-storage-still-face-long-waits/)).
- **Big sites.** Nearly half of the world's solar PV installations are large utility-scale systems, spanning tens of thousands of modules and acres ([EPRI via Power Engineering](https://www.power-eng.com/renewables/solar-energy/epri-white-paper-drones-save-time-money-with-solar-pv-o-m/)).
- **Not enough skilled people.** The CEO of wind-robotics company Aerones says there are not enough qualified technicians to keep up with the industry's growth ([Pulse 2.0](https://pulse2.com/aerones-62-million-raised-for-robotic-solutions-for-wind-turbines/amp/)).
- **Investors agree the physical world is next.** YC's Fall 2026 list asks for software that routes work among AI agents, robots, and human workers ([YC](https://www.ycombinator.com/rfs)).

The common thread: robots and drones are arriving, but each one still needs a person to decide what it does next and to step in when it fails.

## What we would build

The product is a coordination engine: software that decides who does which job, in what order, and who gets called when something goes wrong, for a mix of AI agents, robots, and people.

We start in simulation, so the first version needs no hardware and costs close to nothing. A first version would include:

- **One simulated solar site**, laid out as a map with rows of panels (about 20 rows by 40 panels to start).
- **Generic workers:** drones that find problems, a ground robot that checks them up close, and human technicians who fix what robots cannot. Each worker has a type, speed, skills, and shift, so drone vendors and inspection crews fit the same model.
- **Faults:** hotspot, soiling, string outage, tracker stuck.
- **A task list** that fills as problems are found (inspect, verify, repair, replace).
- **A coordination layer** that assigns work, handles hand-offs, and escalates to a person. It starts rule-based: priority by severity and wait time, nearest capable worker, explicit hand-off events, and first-class failure cases (battery dies, robot cannot confirm, no tech on shift, hand-off times out). The Claude API is used only to explain escalations to the human, never to make the dispatch decisions, so runs stay repeatable and the product is not a wrapper.
- **A clear view for the human**, with approve, reassign, and take-over controls, playback, and scrubbing. This is where design matters.
- **Simple measures:** how long faults wait before being fixed, how many hand-offs fail, and worker utilization.
- **Crew mode (later):** a real person enters their own crew, sites, and faults, and runs the engine on their data.

The engine is meant to be reusable. Wind and data-center settings would be new scenarios on the same engine, not a rewrite.

## Where it applies

Solar is the best first setting: it is easy to simulate, its customers look reachable, and it has room for a newcomer.

| Setting | Ease of simulating | Who buys | Players found | Main risk | Order |
| --- | --- | --- | --- | --- | --- |
| Solar farms | Medium-easy: flat site, many identical units | Plant owners, operators, maintenance teams, utilities | [Raptor Maps](https://www.cbinsights.com/company/raptor-maps), $62.97M raised | Utilities adopt slowly | First |
| Wind turbines | Harder: 100 m towers, weather windows, offshore trips | Operators, turbine makers, independent service firms | [Aerones](https://pulse2.com/aerones-62-million-raised-for-robotic-solutions-for-wind-turbines/amp/), $62M raised June 2025; [BladeBUG](https://www.windsystemsmag.com/?p=27937), pre-commercial in 2022 | Buyers concentrated among big names | Second |
| Data centers | Easy: indoor, discrete jobs | A few hyperscalers and the robot startups serving them | [Watney](https://app.dealroom.co/news/note/data-centre-robot-startup-watney-raises-80m-series-a), $80M Series A, Sept 2026 | Few buyers, well-funded rivals | Later |
| Farms | Hardest: weather, terrain, crops | Farmers, mostly high-value crop growers | [FarmWise](https://agfundernews.com/tag/farm-robotics-mechanization-equipment/) is winding down | [52% of North American farmers cited upfront cost](https://supplychangecapital.substack.com/p/part-i-agricultural-robotics-and) in a 2022 survey | Last |

The customer descriptions are from the sources linked here. We have not counted how many operators or maintenance firms exist in any of these settings.

## Who else is here, and the gap

Companies exist on the robot side and the solar-software side, but we did not find one that focuses on how people fit in alongside robots and agents.

| Company | What it does | Raised |
| --- | --- | --- |
| [Viam](https://www.viam.com/) | A platform to build, deploy, and operate robotics apps, from one robot to a million, including fleet updates and safety limits | $117M, Series C ([CB Insights](https://www.cbinsights.com/company/viam/)) |
| [InOrbit](https://www.cbinsights.com/company/inorbit) | Cloud orchestration for multi-vendor robot fleets, with humans acting as operators | $12.8M, including a $10M Series A |
| [FieldAI](https://www.constructiondive.com/news/fieldai-funding-robotics-startup-work/758711/) | Software "brain" that lets robots work on their own in unmapped sites, including construction | $405M across two rounds, announced August 2025 |
| [Raptor Maps](https://www.cbinsights.com/company/raptor-maps) | Solar asset management software, plus Sentry, an autonomous drone-in-a-box inspection system. Its site says it orchestrates field work across human and robotic workers and has a technician mobile app (marketing copy only, depth unverified) | $62.97M, latest a $35M Series C about two years before the page was captured |
| [Aerones](https://pulse2.com/aerones-62-million-raised-for-robotic-solutions-for-wind-turbines/amp/) | Robotic inspection and maintenance for wind turbines | $62M in June 2025 |
| [Watney](https://app.dealroom.co/news/note/data-centre-robot-startup-watney-raises-80m-series-a) | Robots for data-center work such as cable swaps | $80M Series A, over $100M total |

Other names seen in passing: Swap Robotics (Silicon Ranch invested in 2025). Not researched further.

**The gap we think exists:** most of these companies manage the robots. Few appear to focus on the human side, meaning who does what, hand-offs between machines and people, and oversight. Watney's own coverage notes its robots are still slower than people and need supervision, which supports the idea that the human side matters.

**Where Arien aims:** depth on the human side in one setting. That means hand-offs, escalation, and failure handling for mixed crews at small and mid-size O&M companies, not beating funded teams on the general version. Raptor Maps is the one to watch, since it claims human and robot orchestration. Checking what its product really does for crew scheduling is still open.

## Customers and the path to revenue

The realistic first customers are small and mid-size solar maintenance companies and drone-inspection providers, and nobody has yet confirmed they would pay.

The buyer is usually the maintenance contractor, not the plant owner. Owners, mostly independent power producers, hire contractors, so they are an indirect customer.

The market is concentrated. The top 15 providers manage 57% of the 348 GW under maintenance worldwide, led by NovaSource (38.4 GW), RES (21.9 GW), and SOLV Energy (20+ GW) ([GreenTech Lead](https://greentechlead.com/solar/global-solar-om-market-reaches-348-gw-as-top-15-providers-control-57-percent-55066)). These firms have budgets but are already building monitoring and drone programs themselves, and North American full-service contract costs fell 18% in a year. The other 43% is where small and mid-size providers sit.

Outreach so far: a Notion tracker of about 28 companies ("Arien: Solar Outreach Tracker"). Emails to Cleanleaf, ACT Power, and QE Solar were scheduled for Oct 26. Four more drafts (MEI, CES, Silicon Ranch, Amicus) sit in Gmail unsent. No replies reported as of Nov 15.

There are three possible ways money could arrive. All three are untested.

1. **A paid pilot (priority).** A maintenance or inspection company pays a flat fee to run the dispatch board on one of its sites or on its own crew data. Pitch with the before-and-after comparison from the sim.
2. **Licensing the simulation.** Robot and drone makers use the simulated sites to test how their machines work with people. A guess based on how robotics teams test products.
3. **A subscription product, later.** Only worth considering after one of the first two works.

We have no price data and will not invent any. Ask what people pay today for similar tools, then price the pilot just under that.

## Risks and how to test them

| Risk | Why it matters | How to test it |
| --- | --- | --- |
| Nobody feels this pain | Without a felt problem, nothing else matters | Keep the outreach going and listen for the coordination problem unprompted. Show the demo to anyone who replies |
| The simulation is not believable | A fake that practitioners reject has no value | Have a solar practitioner sanity-check fault types and worker speeds after phase 2, before the dashboard is built on them |
| Incumbents add this | Viam or Raptor Maps could extend into human coordination | Look closely at what their products already do for human crews |
| Customers build it themselves | Robot makers may handle coordination in-house | Ask them directly in conversations |
| Slow buyers | Utilities adopt slowly, per EPRI | Aim first at small and mid-size firms, not utilities |
| Time swings from week to week | Hours vary with school and competitions | Keep each phase small, ship ugly and move on if one stalls |
| We are too early | Most drone use today is simple: fly, capture images, flag problems | The crew-mode version works for people and vendors today, so it does not depend on robot fleets |
| Building does not test demand | Code alone cannot show anyone would pay | Put the demo in front of real operators as early as phase 4 |

## Legal and licensing

Nothing blocks the build: working in simulation needs no licenses or filings. The issues start when the software gets near real drones or real plants. This is not legal advice.

| Issue | When it matters | What to do |
| --- | --- | --- |
| Drone rules | Only if you or your software operate real drones | Commercial flying needs a Part 107 remote pilot certificate (minimum age 16, 60-question exam, about $175). Flying beyond visual line of sight currently needs a case-by-case waiver. |
| Cybersecurity rules | When your software connects to a real plant | Stay read-only and off live plant systems at first |
| Open-source licenses | When you build on Viam | The Viam Python SDK is Apache 2.0, a permissive license. Viam's server and platform terms are unchecked. |
| Contracts and liability | When you charge anyone | Set up a company and written contracts. If you are under 18, check whether an adult must co-sign. A flat-fee lawyer consult is cheap. |

**Drones.** The [FAA's proposed Part 108 rule](https://airdata.com/blog/2026/part-108) would create a framework for flying beyond line of sight and move responsibility from individual pilots to the operating organization. As of a July 2026 update it was still proposed and had gone to final federal review on July 10, 2026. If your software only coordinates and a licensed operator flies, the drone rules mostly land on the operator. That is our reading, not legal advice. Part 107 details are in the [UMD Extension guide](https://www.extension.umd.edu/resource/guide-faa-part-107-certification-and-drone-registration-fs-2026-0803).

**Cybersecurity.** Per a [Solar Power World op-ed](https://www.solarpowerworldonline.com/2026/05/op-ed-nerc-compliance-is-critical-to-national-energy-security/), wind, solar, and storage plants rated 20 MW or above and connected at 60 kV or higher now face mandatory NERC requirements, down from a 75 MW threshold before. Penalties can reach $1.5 million per day. The article does not address software vendors directly. Our inference is that owners will demand security reviews from vendors that connect to plant systems.

## Plan: build-first (replaces the Oct 23 six-week plan)

Each phase ends with something runnable. Phases are sized by what is done, not by hours. Build in Claude Code inside Cursor, one phase per session.

**Repo setup.** Fresh repo at `/Users/anshmehta/arien`. Folders: `/engine` (pure TypeScript, no React imports), `/scenarios` (JSON), `/app` (dashboard). `CLAUDE.md` at the root carries the rules: the engine is deterministic with a seeded RNG, the engine never imports UI code, every phase ends runnable, and any figure that looks like real-world data gets an `// ASSUMPTION` comment.

1. **Site and world (engine only).** Panel grid, tick clock, seeded fault generator. Done when a script prints a 1,000-tick fault log, and the same seed always gives the same log.
2. **Workers and tasks.** Drone, ground robot, and technician as generic workers with speed, skills, and shift. Task states: detected, inspect, verify, repair, done, with replace as a branch. Done when workers move and tasks change state headless. Then ask a practitioner to sanity-check fault types and speeds.
3. **Coordination layer (the product).** Rule-based dispatcher with logged reasons for every decision, explicit hand-off events, and the failure cases. Done when every decision prints a "why".
4. **Metrics and comparison.** Fault wait time, failed hand-offs, utilization. Done when a naive dispatcher and Arien's dispatcher run on the same seed and print a comparison. This comparison is the sales pitch.
5. **Dashboard (beautiful by design).** Site map with live workers, task queue, escalation inbox, metrics strip, human override, playback and scrubbing. First do a visual review of Viam, Hut 8, and SpaceX in a browser, then set design tokens, then build. 5b. **Landing page** on the same tokens: one promise, one action ("Try the simulation"), the three-stage story, and real numbers from the comparison run.
6. **Crew mode.** A person enters their own crew, sites, and faults, then runs the engine on their data.
7. **Scenarios and demo.** Storm day, half the techs call out, double the drone fleet. A "compare dispatchers" view, a 60 to 90 second video, and a short write-up.
8. **Pilot offer.** Send the demo to everyone in the outreach tracker, and offer a flat-fee pilot to anyone who engages.

**Cut from v0:** auth, multi-site, real maps, real weather, and hardware. The landing page waits until the dashboard exists (phase 5b).

**Gates (kept as checks, no longer blocking):**
- **A:** do people who run or service solar sites describe the coordination problem themselves, unprompted? Still open, no replies yet.
- **B:** does a solar practitioner call the simulation believable? Test after phase 2 and again at phase 4.
- **C:** will any company try it, give real feedback time, or pay?

## Next actions

1. Create the repo at `/Users/anshmehta/arien`, with `CLAUDE.md` holding the rules above. (`CLAUDE.md` drafted Nov 15.)
2. Run phase 1 in Claude Code today.
3. Send the four unsent Gmail drafts (MEI, CES, Silicon Ranch, Amicus), and check the Notion tracker for any replies to Cleanleaf, ACT Power, and QE Solar.
4. Find one practitioner willing to sanity-check fault types and worker speeds after phase 2.
5. Check Raptor Maps' products for any crew scheduling or work-order features.
6. Look at Viam's, Hut 8's, and SpaceX's sites in a browser before the dashboard phase, and write down what to borrow.
7. Take Viam's free course and check how open its community and registry are, if time allows.

## Design: UI theme and landing page

**Beauty is a requirement, not polish.** The dashboard is what people see first, so the UI theme and the landing page share one design language. Design references: [Viam](https://www.viam.com/), [Hut 8](https://www.hut8.com/), and SpaceX (added Nov 15; not yet reviewed, and the notes below cover only Viam and Hut 8).

**How it gets built:**
- Before phase 5, do a visual review of all three in a browser (colors, type, spacing, imagery, motion). Write down what to borrow as ideas, not looks.
- Define design tokens first (colors, type scale, spacing, radii) in one file, so the whole UI uses one theme.
- Phase 5 is the dashboard with that theme. The landing page moves up to phase 5b, right after the dashboard, and shares the same tokens.
- Use the frontend-design skill for the dashboard and landing page passes.

The notes below come from each page's text and structure. We have not looked at their colors, type, or imagery, so a visual review in a browser comes before borrowing anything.

**Viam**

- Leads with a bold headline, a one-line value statement, and a "Start free" button.
- Follows with a client logo strip, then short labeled feature sections and a three-stage story (develop, deploy, operate).
- Text-led and minimal, with a confident, concise tone and a closing call to action.

**Hut 8**

- Headline: "Where Power Unlocks Potential." The tone is confident and forward-looking.
- Explains the business as three numbered layers (power, digital infrastructure, compute).
- Backs the claims with concrete figures, a list of sites with megawatt numbers, then press links and client and investor entry points.

**What to borrow (ideas, not looks)**

- One promise and one action above the fold, such as "Try the simulation."
- A simple three-stage picture of how the product works.
- Concrete numbers, such as how long faults wait before being fixed in the simulation.
- A free path in, not a sales form.

Build an identity of your own. Use these two for structure and tone, not for layout, wording, or brand elements.

## Open questions and sources

- How many solar maintenance and inspection companies exist, and how big are they?
- How do drones, robots, and crews get assigned to jobs today, and what goes wrong?
- What do small and mid-size O&M companies pay today for scheduling or dispatch tools?
- How open is Viam's community and registry to outside builders?
- Does Raptor Maps or any other solar tool already schedule human crews alongside robots?
- Who would review the simulation scenarios for realism?
- Space came up as another sector. It has not been researched.

**Sources** (pages opened, October 2026)

- [YC Requests for Startups, Fall 2026](https://www.ycombinator.com/rfs)
- [Modelence: YC RFS Fall 2026, operating systems for the physical world](https://modelence.com/yc-rfs-fall-2026/new-operating-systems-for-the-physical-world)
- [Viam](https://www.viam.com/) and [CB Insights: Viam](https://www.cbinsights.com/company/viam/)
- [Hut 8](https://www.hut8.com/)
- [CB Insights: InOrbit](https://www.cbinsights.com/company/inorbit)
- [PRWeb: InOrbit at Automate 2026](https://www.prweb.com/releases/inorbitai-demonstrates-the-future-of-multi-vendor-robot-orchestration-and-physical-ai-at-automate-2026-302805136.html)
- [Construction Dive: FieldAI funding](https://www.constructiondive.com/news/fieldai-funding-robotics-startup-work/758711/)
- [CB Insights: Raptor Maps](https://www.cbinsights.com/company/raptor-maps)
- [Raptor Maps: RaptorCon 26 O&M robotics session](https://raptormaps.com/events-webinars/raptorcon-26-operations-maintenance-robotics-cleanleaf-session)
- [GreenTech Lead: global solar O&M market, top 15 providers](https://greentechlead.com/solar/global-solar-om-market-reaches-348-gw-as-top-15-providers-control-57-percent-55066)
- [Power Engineering: EPRI on drones in solar O&M](https://www.power-eng.com/renewables/solar-energy/epri-white-paper-drones-save-time-money-with-solar-pv-o-m/)
- [pv magazine USA: interconnection and 2026 capacity](https://pv-magazine-usa.com/2026/07/10/grid-operators-make-interconnection-progress-but-solar-and-storage-still-face-long-waits/)
- [AirData: FAA Part 108 explained](https://airdata.com/blog/2026/part-108)
- [UMD Extension: FAA Part 107 certification guide](https://www.extension.umd.edu/resource/guide-faa-part-107-certification-and-drone-registration-fs-2026-0803)
- [Solar Power World: NERC compliance op-ed](https://www.solarpowerworldonline.com/2026/05/op-ed-nerc-compliance-is-critical-to-national-energy-security/)
- [PyPI: Viam Python SDK](https://pypi.org/project/viam-sdk/0.7.0rc1)
- [Dealroom: Watney Series A](https://app.dealroom.co/news/note/data-centre-robot-startup-watney-raises-80m-series-a)
- [Pulse 2.0: Aerones](https://pulse2.com/aerones-62-million-raised-for-robotic-solutions-for-wind-turbines/amp/)
- [Wind Systems: BladeBUG profile](https://www.windsystemsmag.com/?p=27937)
- [Supply Change Capital: agricultural robotics](https://supplychangecapital.substack.com/p/part-i-agricultural-robotics-and)
- [AgFunder News: farm robotics](https://agfundernews.com/tag/farm-robotics-mechanization-equipment/)
