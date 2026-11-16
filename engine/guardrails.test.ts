// Enforces CLAUDE.md rules 1 and 2 on every engine file:
// no React / Next / app imports, no Math.random, no Date.now.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = __dirname;

function engineSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return engineSources(full);
    const isSource = /\.tsx?$/.test(name) && !name.endsWith(".test.ts");
    return isSource ? [full] : [];
  });
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ["imports react", /from\s+["']react(-dom)?(\/[^"']*)?["']/],
  ["imports next", /from\s+["']next(\/[^"']*)?["']/],
  ["imports from /app", /from\s+["'](@\/app|(\.\.\/)+app)(\/[^"']*)?["']/],
  ["uses Math.random", /Math\.random\s*\(/],
  ["uses Date.now", /Date\.now\s*\(/],
  ["uses new Date()", /new\s+Date\s*\(/],
  // These may return slightly different floats in different JS engines, which would
  // break "same seed, same run" between Node tests and a browser.
  ["uses an engine-dependent Math function", /Math\.(hypot|sin|cos|tan|asin|acos|atan|atan2|exp|expm1|log|log2|log10|log1p|pow|cbrt|sinh|cosh|tanh)\s*\(/],
];

describe("engine guardrails", () => {
  const files = engineSources(ENGINE_DIR);

  it("finds engine source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${relative(ENGINE_DIR, file)} stays pure and deterministic`, () => {
      const src = readFileSync(file, "utf8");
      const hits = FORBIDDEN.filter(([, re]) => re.test(src)).map(([why]) => why);
      expect(hits).toEqual([]);
    });
  }
});
