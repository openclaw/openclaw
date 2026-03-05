import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      exclude: [
        "node_modules/",
        "dist/",
        "**/*.d.ts",
        "**/*.config.*",
        "**/mockData",
        "test/",
      ],
    },
    include: [
      "packages/**/*.{test,spec}.{ts,tsx}",
      "apps/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["node_modules", "**/node_modules/**", "dist", ".next", "out"],
  },
  resolve: {
    alias: {
      "@studio/timing": path.resolve(
        __dirname,
        "./packages/@studio/timing/src",
      ),
      "@studio/hooks": path.resolve(__dirname, "./packages/@studio/hooks/src"),
      "@studio/core-types": path.resolve(
        __dirname,
        "./packages/@studio/core-types/src",
      ),
      "@studio/easings": path.resolve(
        __dirname,
        "./packages/@studio/easings/src",
      ),
      "@studio/transitions": path.resolve(
        __dirname,
        "./packages/@studio/transitions/src",
      ),
    },
  },
});
