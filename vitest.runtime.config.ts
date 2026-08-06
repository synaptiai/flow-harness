import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/runtime/**/*.runtime.test.ts"],
    testTimeout: 15_000,
  },
});
