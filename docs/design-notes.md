# Design notes

Reference review of Viam, Hut 8 and SpaceX, plus the proposed Arien tokens. Written Nov 15, 2026, before phase 5.

## How this review was done

The Chrome extension wasn't connected, so this is **not a screenshot review**. Instead I downloaded each homepage's HTML and stylesheets and pulled out the real values: color variables, font families, type scale, letter-spacing, radii, transitions and keyframes. That covers colors, type, spacing and motion well. Imagery and overall feel are based on page structure (counts of `<img>`, `<video>`, Lottie, SVG), not on looking at the pages.

**To do before building the dashboard:** spend 10 minutes looking at all three sites in a browser to check the "feel" notes below. Values pulled from CSS can't tell you how much of the page actually uses them.

SpaceX renders everything client-side (Angular), so only its global stylesheet and main bundle were readable. Treat its notes as thinner.

---

## Viam (viam.com)

**Colors.** Near-black base (`#151316`, with `#211f22` as the second surface), white text, and muted white at 60% (`#fff9`). One loud accent: acid lime `#c4f400`, plus two backup greens (`#00f400`, `#27643a`). Gray `#3a3a3a` for borders.

**Type.** Public Sans for body (the main face, used in 137 rules). Roboto Mono and Space Mono for labels and code-ish detail, Space Grotesk for some display text. The CSS sets nine named weights but mostly uses 300 and 400, so the type is light. Small labels get wide tracking (0.5 to 2px), which is the usual "technical label" look. The heading scale is modest: h1 is 2.5 to 3rem, with steps to 60px in places.

**Spacing and shape.** Small radii: 2, 4, 6, 8, 10px, plus pill shapes. 4px is the most common. Feels engineered, not bubbly.

**Imagery.** Text-led. Six Lottie animations (an illustration, a "deploy 0 to 100" animation, a "grid snake") and about 24 images, mostly logos. No video. Product ideas are shown as diagrams, not photos.

**Motion.** GSAP with ScrollTrigger, SplitText and CustomEase, so headlines animate in by line or word as you scroll. UI transitions are short (0.2s), with an easeOutExpo-style curve `cubic-bezier(.19,1,.22,1)`.

**Structure and tone.** h1 "The harness for physical AI." Then: a five-point feature grid, then **Develop / Deploy / Operate**, then a row of stat headings (740+, 200+, 1,500+, 10 Days), then a learn path and a closing call to action. Confident and short. Numbers do the persuading.

## Hut 8 (hut8.com)

**Colors.** A two-theme system: off-black `#080808` and off-white `#f8f8f8` swap roles between sections (`--theme-color-background` / `foreground` / `accent`). The accent is a bright lime `#b3ff00`, and a whole section can flip to lime as its background. A careful gray ramp (`#e8e8e8` to `#454545`), a quiet sage `#bcbfb0`, and a hidden electric blue `#30f`. Muted tones are 10% alpha of the foreground, not separate grays.

**Type.** One family, ITC Franklin Gothic, mostly at weight 500. The scale is **huge**: heading-1 runs 130px on mobile and **255px** on large screens, heading-2 60 to 100px, and tracking tightens as size grows (-0.04em at the top, -0.02em in the middle). Separate "label" and "body" scales. This is where the "big type" feeling comes from.

**Spacing and grid.** Real grid tokens: 16 columns on desktop and 8 on mobile, 18 to 24px gutters, 1600px max width. Section spacing is large and responsive (`--space-128` = 80px on mobile, 128px on desktop; `--space-144` = 96px / 144px).

**Imagery.** One background video and 49 inline SVGs (icons, dividers, a "notch" detail), no `<img>` tags on the homepage. Hand-built details: an "angled divider" and a notched corner.

**Motion.** Slower and smoother than Viam: transforms at 0.4s on `cubic-bezier(.215,.61,.355,1)` (easeOutCubic), opacity fades at 0.3s, **staggered delays** (0, 0.04, 0.08, 0.12s) for groups of items, and a 1.1s stroke animation for line drawings. There's an animated counter ("mw 0") that counts up to the real number.

**Structure and tone.** One long statement, then **Layer 1.0 Power / 2.0 Digital Infrastructure / 3.0 Compute**, then "Capacity Under Mgmt." with a counted-up MW figure, then the businesses, news and signup. Version-numbered layers make the stack feel like engineering.

## SpaceX (spacex.com)

**Colors.** Pure black `#000` with a single off-white `rgb(240,240,250)` (slightly blue). Every other shade is that same white at a set opacity: 100, 90, 80, 70, 60, 50, 35, 30, 15, 10%. Plus a few dark-gray glass layers (`rgba(37,38,40,.4/.6/.8)`). No accent color at all.

**Type.** D-DIN (DIN-style, from road signs and engineering drawings) in regular, bold and PRO weights, and Roboto Mono for data. Heavy use of **uppercase** (16 rules), slight positive tracking (0.02em) on labels. Big jumps in size: 3rem, 5rem, 100px.

**Imagery.** From the API endpoints in the bundle (`homepage-tiles`, `featured-launch-tiles`, `media-playlist`, vehicle stats), the homepage is a stack of full-screen tiles, each a launch photo or video. The real hardware is the hero. Not verified visually this session.

**Motion.** A strict entrance order for each tile: headline rises in (0.75s ease-in-out), subheader 0.5s later, button 1s later. Opacity transitions run 0.3 to 0.5s. A **blinking indicator** (`blinker 2.5s`, a hard on/off step, not a fade) and a digit countdown component, which is the "live mission" signal.

**Structure and tone.** Almost no copy. Headline, one line, one button per screen. Vehicle pages lead with spec numbers (height, mass, payload).

---

## What all three share

- **Dark-first, nearly monochrome.** Gray layers are opacity steps of one white, not a pile of unrelated grays (SpaceX does this fully, Hut 8 for muted tones).
- **At most one accent**, used sparingly. Viam and Hut 8 **both use acid lime**, which tells us something: lime-on-black is now the "deep tech" default.
- **Type does the heavy lifting.** One main family, a mono for data, and tracking that tightens as size grows.
- **Numbers as headlines.** Stat rows, counted-up figures, spec sheets.
- **A numbered story in three steps.** Develop/Deploy/Operate, Layer 1.0/2.0/3.0.
- **Motion has an order.** Things enter one after another (Hut 8's stagger, SpaceX's headline then subhead then button), with ease-out curves. Nothing bounces.

## What to borrow (ideas, not looks)

1. **Color carries meaning, not decoration.** Make the chrome monochrome (one off-white at set opacities on near-black) and spend color only on data: fault severity, worker type, the human. In mission control, a color should always tell you something. *(SpaceX's discipline, applied to a dashboard.)*
2. **Stay away from lime.** Both premium references already use it. Arien's accent should come from our own world: **sun gold**, the color of the thing the site exists to capture. We reserve it for **the human**: escalations, the override controls, the technician marker. Gold = "a person should look at this." That's an idea of our own, not a copy.
3. **Huge numbers with tight tracking.** Landing page: the comparison result ("faults wait X% less") as a Hut 8-sized display number with negative tracking. Dashboard: the metrics strip uses big tabular figures in mono.
4. **Version-numbered story.** Three stages, numbered like engineering steps: `01 Detect` (drone) → `02 Verify` (ground robot) → `03 Repair` (technician). This mirrors our real task pipeline, so it isn't decoration.
5. **Opacity-based layers.** Borders, muted text and hover states come from the foreground color at fixed alpha steps. Fewer tokens, always consistent.
6. **A visible grid.** A 12-column layout with real gutter and max-width tokens. On the dashboard, the site map's panel grid *is* the main image, so the layout should echo it (thin rules, aligned edges).
7. **Ordered, quick motion.** Entrances: headline, then subhead, then action, with 40ms staggers for lists (task queue rows, escalation cards). UI responses under 200ms on an ease-out curve. Live elements (workers moving on the map) use linear interpolation between sim ticks, because real machines don't ease.
8. **One hard-blink "live" signal.** A small stepped blink (on/off, not a pulse) next to the sim clock while playback runs. One per screen, never more.
9. **The real thing as imagery.** SpaceX shows rockets, not stock photos. Our "hardware" is the simulated site, so the landing hero should be the live sim map itself, not illustrations or stock solar photos.
10. **Small radii.** 2 to 6px. Engineered, not soft.

**Don't borrow:** their fonts (Public Sans, Franklin Gothic, D-DIN), lime, Hut 8's notch and angled divider, SpaceX's all-caps everywhere, Viam's Lottie illustration style, or any layout or wording.

---

## Proposed tokens

File: [app/tokens.css](../app/tokens.css). It's **written but not imported yet**, so nothing in the app changes until phase 5 adds `@import "./tokens.css";` to `globals.css`. It uses Tailwind v4's `@theme`, so every token becomes a utility (`bg-surface-1`, `text-fg-muted`, `text-display-xl`, `rounded-sm`, `ease-out-quart`…), and components never hardcode values.

### Palette

| Role | Token | Value | Contrast on `ink` |
|---|---|---|---|
| Base | `ink` | `#07090C` | n/a |
| Surfaces | `surface-1/2/3` | `#0E1116` / `#151A21` / `#1D232C` | n/a |
| Text | `fg` | `#ECEEF2` | 17.2:1 |
| Muted text | `fg-muted` | `#9AA3AE` | 7.8:1 |
| Faint (non-essential only) | `fg-faint` | `#646D78` | 3.8:1 |
| Lines | `line`, `line-strong` | fg at 8% / 16% | n/a |
| Human / action accent | `sun` | `#F2B84B` | 11.1:1 |
| Critical (also escalations) | `critical` | `#FF5A5F` | 6.5:1 |
| Major | `major` | `#FF7A45` | n/a |
| Minor | `minor` | `#8FA3BF` | 7.8:1 |
| Done / healthy | `ok` | `#3DDC97` | 11.3:1 |
| Drone | `drone` | `#5CC8FF` | 10.6:1 |
| Ground robot | `robot` | `#B69CFF` | 8.7:1 |
| Technician | `tech` = `sun` | `#F2B84B` | 11.1:1 |

All text colors pass WCAG AA on the base and first surface, except `fg-faint`, which is for decoration only. **Check on the real map:** `major` orange vs `sun` gold are about 15° apart in hue. Faults are tile fills and workers are shaped markers, so shape should separate them, but look at it in phase 5.

The light theme is out of scope for v0 (the brief says dark-first). The landing page uses the same dark tokens.

### Type

- **Archivo** (variable, with a width axis) for UI and display. We can use its expanded width for landing headlines, which looks unlike any of the three references.
- **JetBrains Mono** for numbers, IDs, the sim clock and logs, with `tabular-nums` so changing figures don't shift sideways.
- Both are free Google fonts loaded through `next/font`. This replaces the Geist default from the Next.js starter.
- Scale: 12 / 13 / 14 / 16 / 20 / 24 / 32 / 48 / 72 / 112 / 160px. Tracking goes from +0.06em (small mono labels) to -0.04em (display). Dashboard text lives at 12 to 16px; 48px and up is for metrics and the landing page.

### Spacing, radii, motion

- 4px base spacing (Tailwind's `--spacing`), plus layout tokens: 12 columns, 24px gutter, 1440px max width, and section spacing of 96px on mobile / 160px on desktop.
- Radii: 2 / 4 / 6 / 10px, plus pill.
- Durations: 120ms (hover), 200ms (UI), 400ms (panels), 750ms (entrances). Easings: `out-quart` for UI, `out-expo` for entrances, `linear` for sim movement. 40ms stagger step. The blink is a 1.2s stepped on/off. Everything respects `prefers-reduced-motion`.

## Open questions

- Visual check of all three sites in a browser (see the top of this file).
- Font choice is a proposal. Try Archivo against IBM Plex Sans in the first dashboard mock before committing.
- Does gold for "human" read clearly to a real O&M person? Ask during the practitioner review.
