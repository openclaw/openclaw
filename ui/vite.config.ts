import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "/";
  if (trimmed === "./") return "./";
  if (trimmed.endsWith("/")) return trimmed;
  return `${trimmed}/`;
}

export default defineConfig(({ command }) => {
  const envBase = process.env.CLAWDBOT_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  const proxyTarget = process.env.CLAWDBOT_CONTROL_UI_PROXY_TARGET?.trim();
  return {
    base,
    publicDir: path.resolve(here, "public"),
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      proxy: proxyTarget
        ? {
            // When developing the UI against an already-running gateway, proxy
            // gateway-owned HTTP endpoints to avoid cross-origin/CORS issues.
            "/api": { target: proxyTarget, changeOrigin: true, secure: false },
            "/avatar": { target: proxyTarget, changeOrigin: true, secure: false },
          }
        : undefined,
    },
  };
});
