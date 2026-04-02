import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "../dist/control-ui",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
  },
  server: {
    port: 5173,
  },
});
