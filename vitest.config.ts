import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Substrate-level tests live next to daemon sources.
    include: ["adapters/**/*.{test,spec}.ts", "daemon/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    environment: "node",
  },
});
