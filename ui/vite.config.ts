import fs from "node:fs";
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

// Safety net: if server-only modules are accidentally re-introduced into the
// browser bundle, stub them out rather than crashing the build.
// The primary fix is the source-level separation in src/agents/tools/image-result.ts.
const SERVER_ONLY_PATTERNS = [
  "/src/logging/",
  "/src/config/paths",
  "/src/infra/tmp-openclaw-dir",
  "/src/media/image-ops",
  "/src/agents/tool-images",
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
  // export { name1, name2 as alias }  (skip "export type {")
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

export default defineConfig(() => {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    plugins: [serverOnlyStubPlugin()],
    define: {
      "process.env": "{}",
    },
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
    },
  };
});
