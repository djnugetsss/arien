// The solar site: a grid of panel rows. Pure data, no randomness.

export interface Panel {
  /** Stable id like "R03-P17" (1-based, zero-padded). */
  id: string;
  /** 0-based row index. */
  row: number;
  /** 0-based position along the row. */
  col: number;
  /** Meters east of the site origin (panel center). */
  x: number;
  /** Meters north of the site origin (panel center). */
  y: number;
}

export interface SiteConfig {
  rows: number;
  panelsPerRow: number;
  /** Meters between panel centers along a row. */
  panelSpacingM: number;
  /** Meters between row centerlines. */
  rowPitchM: number;
}

export interface Site extends SiteConfig {
  /** Row-major: all of row 0, then row 1, ... */
  panels: readonly Panel[];
  widthM: number;
  heightM: number;
}

export const DEFAULT_SITE_CONFIG: SiteConfig = {
  rows: 20,
  panelsPerRow: 40,
  panelSpacingM: 1.1, // ASSUMPTION: roughly one utility module width; not checked with a practitioner
  rowPitchM: 6, // ASSUMPTION: typical-looking row spacing; not checked with a practitioner
};

export function panelId(row: number, col: number): string {
  const pad = (n: number) => String(n + 1).padStart(2, "0");
  return `R${pad(row)}-P${pad(col)}`;
}

export function createSite(overrides: Partial<SiteConfig> = {}): Site {
  const config = { ...DEFAULT_SITE_CONFIG, ...overrides };
  const { rows, panelsPerRow, panelSpacingM, rowPitchM } = config;
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(panelsPerRow) || panelsPerRow < 1) {
    throw new Error(`Site needs at least 1 row and 1 panel per row, got ${rows} x ${panelsPerRow}`);
  }

  const panels: Panel[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < panelsPerRow; col++) {
      panels.push({ id: panelId(row, col), row, col, x: col * panelSpacingM, y: row * rowPitchM });
    }
  }

  return {
    ...config,
    panels,
    widthM: (panelsPerRow - 1) * panelSpacingM,
    heightM: (rows - 1) * rowPitchM,
  };
}

/** Panel at (row, col), or undefined if off the grid. */
export function panelAt(site: Site, row: number, col: number): Panel | undefined {
  if (row < 0 || row >= site.rows || col < 0 || col >= site.panelsPerRow) return undefined;
  return site.panels[row * site.panelsPerRow + col];
}
