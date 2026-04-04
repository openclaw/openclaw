import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// Safety net: if server-only modules are accidentally re-introduced into the
// browser bundle, stub them out rather than crashing the build.
const SERVER_ONLY_PATTERNS = [
  "/src/logging/",
  "/src/config/paths",
  "/src/config/version",
  "/src/infra/tmp-openclaw-dir",
  "/src/media/image-ops",
  "/src/agents/tool-images",
  "/src/version.ts",
];

function extractNamedExports(source: string): string[] {
  const names: string[] = [];
  // export function/class/const/let/var/async function name
  const direct =
    /^export\s+(?:declare\s+)?(?:(?:async\s+)?function\s*\*?\s*|class\s+|(?:const|let|var)\s+|enum\s+)(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = direct.exec(source)) !== null) {
    names.push(m[1]);
  }
  // export { name1, name2 as alias } (skip "export type {")
  const braced = /^export\s+(?!type\s*\{)\{([^}]+)\}/gm;
  while ((m = braced.exec(source)) !== null) {
    for (const part of m[1].split(",")) {
      const alias = part.match(/(?:as\s+)?(\w+)\s*$/);
      if (alias) {
        names.push(alias[1]);
      }
    }
  }
  return [...new Set(names)];
}

function serverOnlyStubPlugin() {
  return {
    name: "stub-server-only-modules",
    enforce: "pre" as const,
    transform(_code: string, id: string) {
      const clean = id.split("?")[0];
      if (SERVER_ONLY_PATTERNS.some((p) => clean.includes(p))) {
        let source = "";
        try {
          source = fs.readFileSync(clean, "utf-8");
        } catch {
          // ignore
        }
        const exports = extractNamedExports(source);
        const stubs = exports.map((n) => `export const ${n} = undefined;`).join("\n");
        return { code: `export default {};\n${stubs}`, map: null };
      }
      return null;
    },
  };
}

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
      serverOnlyStubPlugin(),
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
