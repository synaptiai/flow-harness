import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/browser/**/*.browser.test.ts"],
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
