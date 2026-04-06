import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed === "./") {
    return "./";
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  return `${trimmed}/`;
}

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    define: {
      "process.env": "{}",
      "process.cwd": "(() => '/')",
      "process.platform": "'web'",
    },
    resolve: {
      alias: [
        { find: /^jiti$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:fs$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:fs\/promises$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:os$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:crypto$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:module$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:path$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:path\/posix$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:path\/win32$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:util$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
        { find: /^node:url$/, replacement: path.resolve(here, "src/stubs/dummy.ts") },
      ],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
      // Keep CI/onboard logs clean; current control UI chunking is intentionally above 500 kB.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
    },
    plugins: [
      {
        name: "control-ui-dev-stubs",
        configureServer(server) {
          server.middlewares.use("/__openclaw/control-ui-config.json", (_req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                basePath: "/",
                assistantName: "",
                assistantAvatar: "",
              }),
            );
          });
        },
      },
    ],
  };
});
