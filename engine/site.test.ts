import { describe, expect, it } from "vitest";
import { createSite, panelAt } from "./site";

describe("site grid", () => {
  const site = createSite();

  it("defaults to 20 rows x 40 panels = 800 panels", () => {
    expect(site.rows).toBe(20);
    expect(site.panelsPerRow).toBe(40);
    expect(site.panels).toHaveLength(800);
  });

  it("every panel has a unique id and grid position", () => {
    expect(new Set(site.panels.map((p) => p.id)).size).toBe(800);
    expect(new Set(site.panels.map((p) => `${p.row},${p.col}`)).size).toBe(800);
    expect(site.panels[0].id).toBe("R01-P01");
    expect(site.panels[799].id).toBe("R20-P40");
  });

  it("panelAt finds the right panel and returns undefined off-grid", () => {
    expect(panelAt(site, 2, 16)).toMatchObject({ id: "R03-P17", row: 2, col: 16 });
    for (const p of site.panels) expect(panelAt(site, p.row, p.col)).toBe(p);
    expect(panelAt(site, 20, 0)).toBeUndefined();
    expect(panelAt(site, 0, 40)).toBeUndefined();
    expect(panelAt(site, -1, 0)).toBeUndefined();
  });

  it("positions follow spacing and row pitch", () => {
    const p = panelAt(site, 3, 10)!;
    expect(p.x).toBeCloseTo(10 * site.panelSpacingM);
    expect(p.y).toBeCloseTo(3 * site.rowPitchM);
    expect(site.widthM).toBeCloseTo(39 * site.panelSpacingM);
    expect(site.heightM).toBeCloseTo(19 * site.rowPitchM);
  });

  it("building it twice gives identical output", () => {
    expect(createSite()).toEqual(createSite());
    expect(JSON.stringify(createSite())).toBe(JSON.stringify(createSite()));
  });

  it("accepts other sizes and rejects nonsense", () => {
    expect(createSite({ rows: 2, panelsPerRow: 3 }).panels).toHaveLength(6);
    expect(() => createSite({ rows: 0 })).toThrow();
    expect(() => createSite({ panelsPerRow: 2.5 })).toThrow();
  });
});
