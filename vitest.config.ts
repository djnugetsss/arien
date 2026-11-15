import { defineConfig } from "vitest/config";

// Headless tests for the engine and scenarios. No DOM, no React.
export default defineConfig({
  test: {
    environment: "node",
    include: ["engine/**/*.test.ts", "scenarios/**/*.test.ts"],
  },
});
