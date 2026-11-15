"use client";

// TEMPORARY debug viewer for the phase 1 fault generator. Not the dashboard.
// Plain on purpose: no design tokens, delete or replace in phase 5.

import { useMemo, useState } from "react";
import { FAULT_TYPES, createSite, formatLocation, runFaultLog, type Fault, type FaultType } from "@/engine";

const SEED = "arien-demo";
const MAX_TICK = 8640; // one sim day at 10-second ticks

// Debug-only colors. Real colors go in the design-tokens file in phase 5.
const COLORS: Record<FaultType | "ok", string> = {
  ok: "#2a2a2a",
  hotspot: "#e5484d",
  soiling: "#c9a227",
  string_outage: "#3e63dd",
  tracker_stuck: "#8e4ec6",
};

export default function DebugPage() {
  const site = useMemo(() => createSite(), []);
  const faults = useMemo(() => runFaultLog({ seed: SEED, ticks: MAX_TICK, site }), [site]);
  const [tick, setTick] = useState(0);

  // Faults never end yet (phase 1), so "active" means started at or before this tick.
  // If two faults cover a panel, the later one wins.
  const { cells, active } = useMemo(() => {
    const cells: (Fault | undefined)[] = new Array(site.panels.length);
    const active = faults.filter((f) => f.startTick <= tick);
    for (const f of active) {
      for (let col = f.location.colStart; col <= f.location.colEnd; col++) {
        cells[f.location.row * site.panelsPerRow + col] = f;
      }
    }
    return { cells, active };
  }, [faults, site, tick]);

  return (
    <main style={{ padding: 16, fontFamily: "monospace", fontSize: 12, background: "#111", color: "#ddd", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 14, marginBottom: 8 }}>
        Debug: fault grid · seed {JSON.stringify(SEED)} · {site.rows}×{site.panelsPerRow}
      </h1>

      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        tick
        <input
          type="range"
          min={0}
          max={MAX_TICK}
          value={tick}
          onChange={(e) => setTick(Number(e.target.value))}
          style={{ width: 480 }}
        />
        <span style={{ width: 40 }}>{tick}</span>
        <span>active faults: {active.length}</span>
      </label>

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        {FAULT_TYPES.map((type) => (
          <span key={type} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ width: 10, height: 10, background: COLORS[type], display: "inline-block" }} />
            {type} ({active.filter((f) => f.type === type).length})
          </span>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${site.panelsPerRow}, 12px)`, gap: 2, width: "max-content" }}>
        {site.panels.map((panel, i) => {
          const fault = cells[i];
          return (
            <div
              key={panel.id}
              title={fault ? `${panel.id} · ${fault.id} ${fault.type} sev=${fault.severity} from tick ${fault.startTick}` : panel.id}
              style={{ width: 12, height: 12, background: COLORS[fault?.type ?? "ok"] }}
            />
          );
        })}
      </div>

      <ol style={{ marginTop: 16, lineHeight: 1.6 }}>
        {active.map((f) => (
          <li key={f.id}>
            tick {f.startTick} · {f.id} · {f.type} · sev {f.severity} · {formatLocation(f.location)}
          </li>
        ))}
      </ol>
    </main>
  );
}
