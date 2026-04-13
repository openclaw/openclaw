import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: true,
    }),
  ],
  build: {
    target: "node18",
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split runtime entry points into dedicated chunks to prevent
          // circular dependency issues and ensure they are loadable via
          // dynamic imports with stable names.
          if (id.includes("/install.runtime")) {
            return "install.runtime";
          }
          if (id.includes("/subagent-registry.runtime")) {
            return "subagent-registry.runtime";
          }
        },
      },
    },
  },
});
