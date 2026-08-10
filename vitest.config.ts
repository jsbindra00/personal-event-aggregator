import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.live.smoke.test.ts"],
    include: ["**/test/**/*.test.ts", "**/src/**/*.test.ts", "**/src/**/*.test.tsx"]
  }
});

