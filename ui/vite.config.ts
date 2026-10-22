// Control UI config module wires vite behavior.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants } from "node:zlib";
import { gzip } from "pako";
import {
  runnerImport,
  type Plugin,
  type ResolveModulePreloadDependenciesFn,
  type UserConfig,
} from "vite";
import { mermaidClassicBundlePlugin } from "../packages/mermaid-renderer/vite-plugin.ts";
import {
  CONTROL_UI_BUILD_ID_ATTRIBUTE,
  isControlUiVersionedPublicAsset,
} from "../src/gateway/control-ui-root-assets.ts";
import {
  collectControlUiBootAssets,
  controlUiBootPreloadsPlugin,
} from "./config/control-ui-boot-preloads.ts";
import {
  controlUiCodeSplitting,
  controlUiIsolatedDesktopRuntimePlugin,
} from "./config/control-ui-chunking.ts";
import { createControlUiDevGateway } from "./config/control-ui-dev-gateway.ts";
import { controlUiHoverGuardPlugin } from "./config/control-ui-hover-guard.ts";
import { controlUiLocaleModulesPlugin } from "./config/control-ui-locales.ts";
import { controlUiPluginDistributionsPlugin } from "./config/control-ui-plugin-distributions.ts";
import { controlUiSocialCardPlugin } from "./config/control-ui-social-card.ts";
import { controlUiSolidPlugin } from "./config/control-ui-solid.ts";
import { normalizeControlUiBuildInfo } from "./src/build-info-normalizers.ts";
import type { ControlUiBuildInfo } from "./src/build-info.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outDir = path.resolve(here, "../dist/control-ui");
const CONTROL_UI_GIT_READ_TIMEOUT_MS = 2_000;
const require = createRequire(import.meta.url);
const json5EsmPath = require.resolve("json5/dist/index.mjs");

type ControlUiViteAlias = {
  find: string | RegExp;
  replacement: string;
};
export const commonJsOptimizeDeps = [
  "highlight.js/lib/core",
  "highlight.js/lib/languages/bash",
  "highlight.js/lib/languages/cpp",
  "highlight.js/lib/languages/css",
  "highlight.js/lib/languages/diff",
  "highlight.js/lib/languages/go",
  "highlight.js/lib/languages/java",
  "highlight.js/lib/languages/javascript",
  "highlight.js/lib/languages/json",
  "highlight.js/lib/languages/markdown",
  "highlight.js/lib/languages/python",
  "highlight.js/lib/languages/rust",
  "highlight.js/lib/languages/typescript",
  "highlight.js/lib/languages/xml",
  "highlight.js/lib/languages/yaml",
] as const;
// npm excludes dist/**/*.map; sidecars would bypass that rule and ship source
// maps that the browser never needs during normal runtime.
const controlUiPrecompressedAssetExtensions = new Set([
  ".css",
  ".js",
  ".json",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
]);

const compressBrotli = promisify(brotliCompress);

function isControlUiPrecompressedAsset(fileName: string) {
  return (
    fileName.startsWith("assets/") &&
    controlUiPrecompressedAssetExtensions.has(path.extname(fileName).toLowerCase())
  );
}

export async function createControlUiPrecompressedAssetVariants(
  fileName: string,
  source: string | Uint8Array,
): Promise<Array<{ fileName: string; source: Buffer }>> {
  if (!isControlUiPrecompressedAsset(fileName)) {
    return [];
  }
  const body = typeof source === "string" ? Buffer.from(source) : source;
  return [
    {
      fileName: `${fileName}.br`,
      source: await compressBrotli(body, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 10 },
      }),
    },
    {
      fileName: `${fileName}.gz`,
      // Host zlib is byte-unstable across supported runtimes; pako's classic hash is canonical.
      // Smaller deflate blocks reduce startup JavaScript size and encoder memory.
      source: Buffer.from(gzip(body, { level: 9, legacyHash: true, memLevel: 6 })),
    },
  ];
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

function readPackageVersion(): string | null {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function readGit(args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-C", repoRoot, ...args], {
    encoding: "utf8",
    // Metadata reads need no index lock; disabling it makes the hard startup deadline safe.
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: CONTROL_UI_GIT_READ_TIMEOUT_MS,
  });
}

function readGitCommit(): string | null {
  try {
    const raw = readGit(["rev-parse", "HEAD"]);
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function readGitBranch(): string | null {
  try {
    const raw = readGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function readGitCommitTimestamp(commit: string): string | null {
  try {
    const raw = readGit(["show", "-s", "--format=%ct", commit]);
    const seconds = Number.parseInt(raw.trim(), 10);
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function readGitDirty(): boolean | null {
  try {
    const raw = readGit(["status", "--porcelain"]);
    return Boolean(raw.trim());
  } catch {
    return null;
  }
}

type ControlUiBuildInfoSources = {
  env?: NodeJS.ProcessEnv;
  readPackageVersion?: () => string | null;
  readGitCommit?: () => string | null;
  readGitCommitTimestamp?: (commit: string) => string | null;
  readGitBranch?: () => string | null;
  readGitDirty?: () => boolean | null;
};

function normalizeBuildTimestamp(value: string | undefined): string | null {
  const explicit = value?.trim();
  if (!explicit) {
    return null;
  }
  const timestamp = normalizeControlUiBuildInfo({ builtAt: explicit }).builtAt;
  if (!timestamp) {
    throw new Error("OPENCLAW_BUILD_TIMESTAMP must be a valid UTC ISO-8601 timestamp ending in Z");
  }
  return timestamp;
}

export function resolveControlUiBuildInfo(
  sources: ControlUiBuildInfoSources = {},
): ControlUiBuildInfo {
  const env = sources.env ?? process.env;
  const version = (sources.readPackageVersion ?? readPackageVersion)();
  const explicitCommitSource = [
    { name: "GIT_COMMIT", value: env.GIT_COMMIT?.trim() },
    { name: "GIT_SHA", value: env.GIT_SHA?.trim() },
  ].find((source) => source.value);
  const explicitCommit = explicitCommitSource?.value;
  const envCommit = explicitCommit
    ? normalizeControlUiBuildInfo({ commit: explicitCommit }).commit
    : null;
  if (explicitCommitSource && !envCommit) {
    throw new Error(`${explicitCommitSource.name} must be a full 40-character hexadecimal SHA`);
  }
  const gitCommit = explicitCommit ? null : (sources.readGitCommit ?? readGitCommit)();
  const normalizedGitCommit = normalizeControlUiBuildInfo({ commit: gitCommit }).commit;
  if (gitCommit?.trim() && !normalizedGitCommit) {
    throw new Error("git rev-parse HEAD must return a full 40-character hexadecimal SHA");
  }
  // GITHUB_SHA names the workflow invocation and can differ from a checked-out tag.
  const githubCommit = explicitCommit || gitCommit?.trim() ? null : env.GITHUB_SHA?.trim();
  const normalizedGithubCommit = normalizeControlUiBuildInfo({ commit: githubCommit }).commit;
  if (githubCommit && !normalizedGithubCommit) {
    throw new Error("GITHUB_SHA must be a full 40-character hexadecimal SHA");
  }
  const commit = envCommit ?? normalizedGitCommit ?? normalizedGithubCommit;
  // Commit time is advisory identity like branch/dirty: read from the local
  // object store for the exact embedded commit, null when no checkout has it
  // (e.g. GITHUB_SHA-only builds). It must never block a build.
  const readCommitTimestamp =
    sources.readGitCommitTimestamp ??
    // A caller-provided commit reader can return synthetic or remote identity.
    // Do not combine it with a filesystem-bound reader from this checkout.
    (sources.readGitCommit ? () => null : readGitCommitTimestamp);
  const commitAt = commit
    ? normalizeControlUiBuildInfo({
        commitAt: readCommitTimestamp(commit),
      }).commitAt
    : null;
  const builtAt = normalizeBuildTimestamp(env.OPENCLAW_BUILD_TIMESTAMP);
  // Branch/dirty identity is advisory: the readers return null instead of
  // throwing, so malformed environment or Git state never blocks a build.
  // Tags must not be presented as branches in GitHub-built artifacts.
  const githubBranch = env.GITHUB_REF_TYPE === "branch" ? env.GITHUB_REF_NAME : null;
  const branch =
    normalizeControlUiBuildInfo({ branch: env.GIT_BRANCH }).branch ??
    normalizeControlUiBuildInfo({ branch: githubBranch }).branch ??
    normalizeControlUiBuildInfo({ branch: (sources.readGitBranch ?? readGitBranch)() }).branch;
  const dirty = (sources.readGitDirty ?? readGitDirty)();
  const releaseFlag = env.OPENCLAW_CONTROL_UI_RELEASE_BUILD?.trim();
  if (releaseFlag && releaseFlag !== "1") {
    throw new Error("OPENCLAW_CONTROL_UI_RELEASE_BUILD must be 1 when set");
  }
  const release = releaseFlag === "1";
  const metadata = { version, commit, builtAt, release };
  const explicitBuildId = env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim();
  return {
    ...metadata,
    commitAt,
    branch,
    dirty,
    buildId: normalizeControlUiBuildInfo(
      explicitBuildId ? { ...metadata, buildId: explicitBuildId } : metadata,
    ).buildId,
  };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortTsconfigPathEntries(entries: Array<[string, unknown]>): Array<[string, unknown]> {
  return entries.toSorted(([left], [right]) => {
    const leftPrefixLength = left.includes("*") ? left.indexOf("*") : left.length;
    const rightPrefixLength = right.includes("*") ? right.indexOf("*") : right.length;
    if (leftPrefixLength !== rightPrefixLength) {
      return rightPrefixLength - leftPrefixLength;
    }
    return right.length - left.length || left.localeCompare(right);
  });
}

function resolveTsconfigTargetPath(target: string): string {
  return path.resolve(repoRoot, target.replace(/^\.\//, ""));
}

function resolveTsconfigPathAlias(key: string, target: string): ControlUiViteAlias | null {
  const keyWildcardIndex = key.indexOf("*");
  const targetWildcardIndex = target.indexOf("*");
  if (keyWildcardIndex === -1 || targetWildcardIndex === -1) {
    if (keyWildcardIndex !== -1 || targetWildcardIndex !== -1) {
      return null;
    }
    return {
      find: key,
      replacement: resolveTsconfigTargetPath(target),
    };
  }

  if (
    key.slice(keyWildcardIndex + 1).includes("*") ||
    target.slice(targetWildcardIndex + 1).includes("*")
  ) {
    return null;
  }

  const prefix = key.slice(0, keyWildcardIndex);
  const suffix = key.slice(keyWildcardIndex + 1);
  return {
    find: new RegExp(`^${escapeRegExp(prefix)}(.+)${escapeRegExp(suffix)}$`),
    replacement: resolveTsconfigTargetPath(target).replace("*", "$1"),
  };
}

function sourcePackageAlias(packageId: string, subpath?: string): ControlUiViteAlias {
  return {
    find: `@openclaw/${packageId}${subpath ? `/${subpath}` : ""}`,
    replacement: path.join(
      repoRoot,
      "packages",
      packageId,
      "src",
      ...(subpath ? subpath.split("/") : ["index"]).map((part, index, parts) =>
        index === parts.length - 1 ? `${part}.ts` : part,
      ),
    ),
  };
}

export function resolveSourcePackageAliasesForVite(): ControlUiViteAlias[] {
  return [
    sourcePackageAlias("normalization-core", "agent-id"),
    sourcePackageAlias("normalization-core", "code-points"),
    sourcePackageAlias("normalization-core", "grapheme"),
    sourcePackageAlias("normalization-core", "json-coercion"),
    sourcePackageAlias("normalization-core", "json-schema"),
    sourcePackageAlias("normalization-core", "markdown-plain-text"),
    sourcePackageAlias("normalization-core", "number-coercion"),
    sourcePackageAlias("normalization-core", "phone-presentation"),
    sourcePackageAlias("normalization-core", "record-coerce"),
    sourcePackageAlias("normalization-core", "result"),
    sourcePackageAlias("normalization-core", "session-key-comparison"),
    sourcePackageAlias("normalization-core", "stable-stringify"),
    sourcePackageAlias("normalization-core", "string-coerce"),
    sourcePackageAlias("normalization-core", "string-normalization"),
    sourcePackageAlias("normalization-core", "utf16-slice"),
    sourcePackageAlias("normalization-core", "uuid"),
    sourcePackageAlias("normalization-core"),
    sourcePackageAlias("session-url-contract", "parse"),
    sourcePackageAlias("session-url-contract", "session-key-normalization"),
    sourcePackageAlias("session-url-contract", "share-build"),
    sourcePackageAlias("session-url-contract", "public-share"),
    sourcePackageAlias("session-url-contract"),
    sourcePackageAlias("workboard-contract"),
  ];
}

export function resolveExternalPackageAliasesForVite(
  resolvePackage: (specifier: string) => string = require.resolve,
): ControlUiViteAlias[] {
  const packageRoot = (specifier: string) =>
    path.dirname(resolvePackage(`${specifier}/package.json`));
  return [
    {
      find: "@openclaw/libterminal/browser",
      replacement: path.join(packageRoot("@openclaw/libterminal"), "dist/browser.js"),
    },
    {
      find: "@openclaw/uirouter",
      replacement: path.join(packageRoot("@openclaw/uirouter"), "dist/index.js"),
    },
  ];
}

export function resolveTsconfigPathAliasesForVite(): ControlUiViteAlias[] {
  const raw = fs.readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    compilerOptions?: { paths?: Record<string, unknown> };
  };
  const paths = parsed.compilerOptions?.paths;
  if (!paths) {
    return [];
  }

  return sortTsconfigPathEntries(Object.entries(paths)).flatMap(([key, targets]) => {
    if (!Array.isArray(targets) || typeof targets[0] !== "string") {
      return [];
    }
    const alias = resolveTsconfigPathAlias(key, targets[0]);
    return alias ? [alias] : [];
  });
}

const controlUiBuildInfoScriptId = "openclaw-control-ui-build-info";

function controlUiBuildIdentityHtml(html: string, buildInfo: ControlUiBuildInfo, cacheId?: string) {
  const script = `<script data-cfasync="false" id="${controlUiBuildInfoScriptId}">globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO=${JSON.stringify(buildInfo).replaceAll("<", "\\u003c")};</script>`;
  const withoutIdentity = html
    .replace(/<script\b[^>]*\bid="openclaw-control-ui-build-info"[^>]*>[\s\S]*?<\/script>/u, "")
    .replace(new RegExp(` ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="[^"]*"`, "u"), "");
  const insertion =
    withoutIdentity.match(/<head\b[^>]*>/iu) ?? withoutIdentity.match(/<html\b[^>]*>/iu);
  const withIdentity = insertion
    ? withoutIdentity.replace(insertion[0], `${insertion[0]}${script}`)
    : `${script}${withoutIdentity}`;
  return cacheId
    ? withIdentity.replace(/<html\b/iu, `<html ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="${cacheId}"`)
    : withIdentity;
}

/** Refresh only release identity; the immutable bundles and compressed variants stay byte-identical. */
export async function refreshControlUiBuildOutput(
  buildOutDir: string,
  buildInfo: ControlUiBuildInfo = resolveControlUiBuildInfo(),
  bootAssets?: string[],
  publicDir: string | false = path.join(here, "public"),
) {
  const publicContent = publicDir ? collectControlUiPublicAssets(publicDir) : undefined;
  const publicAssets = publicContent?.paths ?? [];
  const cacheId = publicContent ? `${buildInfo.buildId}-${publicContent.hash}` : undefined;
  let selectedBootAssets = bootAssets;
  if (!selectedBootAssets) {
    // Reuse the build-owned graph already serialized by this producer, never a fetched document.
    const worker = fs.readFileSync(path.join(buildOutDir, "sw.js"), "utf8");
    const encoded = worker.match(/^const OFFLINE_BOOT = (.+);$/mu)?.[1];
    if (!encoded) {
      throw new Error("Cached Control UI service worker has no offline build inventory");
    }
    const previous = JSON.parse(encoded) as { assets: Array<{ path: string }> };
    selectedBootAssets = previous.assets
      .map((asset) => asset.path)
      .filter((asset) => asset.startsWith("assets/"));
  }
  const htmlPath = path.join(buildOutDir, "index.html");
  fs.writeFileSync(
    htmlPath,
    controlUiBuildIdentityHtml(fs.readFileSync(htmlPath, "utf8"), buildInfo, cacheId),
  );
  if (publicDir) {
    for (const asset of publicAssets) {
      const fontStylesheet = asset.startsWith("fonts/") && asset.endsWith(".css");
      if (!fontStylesheet && asset !== "manifest.webmanifest") {
        continue;
      }
      const filePath = path.join(buildOutDir, asset);
      const assetSource = fs.readFileSync(path.join(publicDir, asset), "utf8");
      if (fontStylesheet) {
        // Relative CSS URLs do not inherit their parent stylesheet's query.
        const versioned = assetSource.replace(
          /url\("([^"/?#]+\.woff2)"\)/gu,
          `url("$1?v=${cacheId}")`,
        );
        fs.writeFileSync(filePath, versioned);
      } else {
        const manifest = JSON.parse(assetSource) as { icons: Array<{ src: string }> };
        for (const icon of manifest.icons) {
          icon.src += `?v=${cacheId}`;
        }
        fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
    }
  }
  const swPath = path.join(buildOutDir, "sw.js");
  const publicSwPath = path.join(here, "public/sw.js");
  const source = fs.readFileSync(publicSwPath, "utf8");
  const placeholder = '"__OPENCLAW_CONTROL_UI_BUILD_ID__"';
  // Embed only build-owned HTML, never a fetched Gateway document (which may
  // contain identity, route metadata, or an HTTP login response). The measured
  // route graph also warms assets loaded before the first worker controls a tab.
  const { module: routes } = await runnerImport<typeof import("./src/app-route-paths.ts")>(
    path.join(here, "src/app-route-paths.ts"),
    { configFile: false, resolve: { alias: resolveSourcePackageAliasesForVite() } },
  );
  const offlineShell = {
    routes: routes.APP_ROUTE_PATHS,
    routePrefixes: routes.APP_ROUTE_OFFLINE_PREFIXES,
    html: fs.readFileSync(path.join(buildOutDir, "index.html"), "utf8"),
    // Public fonts and theme styles are selected at runtime by preferences.
    // Keep this bounded build inventory, not all lazy pages, locales, or plugins.
    assets: [
      ...new Set([
        ...selectedBootAssets,
        ...publicAssets.filter(
          (asset) => /\.(?:css|woff2)$/u.test(asset) && isControlUiVersionedPublicAsset(asset),
        ),
      ]),
    ]
      .toSorted()
      .map((file) => ({
        path: file.startsWith("assets/") ? file : `${file}?v=${encodeURIComponent(cacheId ?? "")}`,
        integrity:
          "sha256-" +
          createHash("sha256")
            .update(fs.readFileSync(path.join(buildOutDir, file)))
            .digest("base64"),
      })),
  };
  // Same-commit source rebuilds must not pair a new document with an old shell.
  const { module: csp } = await runnerImport<typeof import("../src/gateway/control-ui-csp.ts")>(
    path.join(repoRoot, "src/gateway/control-ui-csp.ts"),
    { configFile: false, resolve: { alias: resolveSourcePackageAliasesForVite() } },
  );
  const offlineBuild = {
    ...offlineShell,
    csp: csp.buildControlUiCspHeader({
      inlineScriptHashes: csp.computeInlineScriptHashes(offlineShell.html),
    }),
    publicAssetVersion: cacheId,
    publicAssets: publicAssets.filter(isControlUiVersionedPublicAsset),
    id: createHash("sha256").update(JSON.stringify(offlineShell)).digest("hex").slice(0, 16),
  };
  const offlinePlaceholder = "const OFFLINE_BOOT = null;";
  if (!source.includes(placeholder) || !source.includes(offlinePlaceholder)) {
    throw new Error(`Control UI service worker build placeholders missing in ${swPath}`);
  }
  const updated = source
    .replace(placeholder, JSON.stringify(buildInfo.buildId))
    .replace(offlinePlaceholder, () => `const OFFLINE_BOOT = ${JSON.stringify(offlineBuild)};`);
  fs.mkdirSync(buildOutDir, { recursive: true });
  fs.writeFileSync(swPath, updated);
}

function controlUiBuildOutputPlugin(
  buildInfo: ControlUiBuildInfo,
  copiedInputs: Set<string>,
): Plugin {
  let publicDir: string | false = false;
  return {
    name: "control-ui-build-output",
    apply: "build",
    configResolved(config) {
      publicDir = (config.build.copyPublicDir && config.publicDir) || false;
      for (const file of config.configFileDependencies) {
        copiedInputs.add(file);
      }
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        // Vite recreates the module entry tag from a fixed attribute set. Finalize every script
        // after synthesis so Cloudflare Rocket Loader cannot defer the Control UI boot sequence.
        const marked = html.replace(
          /<script\b(?![^>]*\bdata-cfasync\s*=)/giu,
          '<script data-cfasync="false"',
        );
        return controlUiBuildIdentityHtml(marked, buildInfo);
      },
    },
    async writeBundle({ dir: buildOutDir }, bundle) {
      if (!buildOutDir) {
        this.error("Control UI build requires an output directory");
      }
      const logger = this.environment.logger;
      let completed = 0;
      let sidecars = 0;
      let lastProgressAt = performance.now();
      logger.info("Control UI precompression: starting");
      const compressAsset = async (output: (typeof bundle)[string]) => {
        // Vite's post-build import analysis rewrites lazy preload markers in a
        // later generateBundle hook. Read from disk here so sidecars always
        // encode the exact final bytes that the identity response serves.
        const source = fs.readFileSync(path.join(buildOutDir, output.fileName));
        const variants = await createControlUiPrecompressedAssetVariants(output.fileName, source);
        if (variants.length === 0) {
          return;
        }
        for (const variant of variants) {
          fs.writeFileSync(path.join(buildOutDir, variant.fileName), variant.source);
        }
        // Only completed writes renew activity; a blocked compression/write must
        // remain silent so the caller's existing watchdog can still terminate it.
        completed++;
        sidecars += variants.length;
        const now = performance.now();
        if (now - lastProgressAt >= 10_000) {
          logger.info(
            `Control UI precompression: ${completed} assets (${sidecars} sidecars) written`,
          );
          lastProgressAt = now;
        }
      };
      const outputs = Object.values(bundle).filter((output) =>
        isControlUiPrecompressedAsset(output.fileName),
      );
      for (let index = 0; index < outputs.length; index += 4) {
        // Bound native compression memory and join every writer before failed-build cleanup.
        const results = await Promise.allSettled(
          outputs.slice(index, index + 4).map(compressAsset),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      }
      logger.info(`Control UI precompression complete: ${completed} assets (${sidecars} sidecars)`);
      const inputs = [...new Set([...this.getModuleIds(), ...copiedInputs])]
        .map((file) => file.split("?")[0])
        .filter((file): file is string => Boolean(file && path.isAbsolute(file)))
        .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
        .filter(
          (file) =>
            !file.startsWith("../") &&
            !file.includes("node_modules/") &&
            fs.statSync(path.join(repoRoot, file), { throwIfNoEntry: false })?.isFile(),
        )
        .toSorted();
      fs.writeFileSync(path.join(buildOutDir, ".build-inputs.json"), JSON.stringify(inputs));
      const bootAssets = collectControlUiBootAssets(bundle);
      await refreshControlUiBuildOutput(
        buildOutDir,
        buildInfo,
        [...bootAssets.chat, ...bootAssets.new, ...bootAssets.login],
        publicDir,
      );
    },
  };
}

function collectControlUiPublicAssets(publicDir: string): { paths: string[]; hash: string } {
  const paths: string[] = [];
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .toSorted((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      // Source maps are diagnostics, not runtime dependencies of an open document.
      const assetPath = path.relative(publicDir, filePath).split(path.sep).join("/");
      if (entry.name.endsWith(".map") || assetPath === "sw.js") {
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Unsafe Control UI build asset: ${filePath}`);
      }
      const source = fs.readFileSync(filePath);
      paths.push(assetPath);
      const digest = createHash("sha256").update(source).digest("hex");
      hash.update(`${assetPath}\0${source.byteLength}\0${digest}\n`);
    }
  };
  visit(publicDir);
  return { paths, hash: hash.digest("hex") };
}

export function controlUiRuntimeDefines(
  command: "serve" | "build" | undefined,
  buildInfo: ControlUiBuildInfo,
) {
  return {
    "globalThis.OPENCLAW_UI_DEV_SERVER": JSON.stringify(command === "serve"),
    ...(command === "serve"
      ? { "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(buildInfo) }
      : {}),
  };
}

export default function controlUiViteConfig(
  options: { outDir?: string; command?: "serve" | "build"; buildInfo?: ControlUiBuildInfo } = {},
): UserConfig {
  const envBase = process.env.OPENCLAW_CONTROL_UI_BASE_PATH?.trim();
  const polling = process.env.CHOKIDAR_USEPOLLING?.toLowerCase();
  const usePolling = Boolean(polling && polling !== "false" && polling !== "0");
  const base = envBase ? normalizeBase(envBase) : "./";
  const bootstrapConfigPath =
    base === "./" ? "/control-ui-config.json" : `${base}control-ui-config.json`;
  const buildInfo = options.buildInfo ?? resolveControlUiBuildInfo();
  const devGateway =
    options.command === "serve"
      ? createControlUiDevGateway(process.env.OPENCLAW_UI_DEV_GATEWAY_URL)
      : undefined;
  const staticImports = new Map<string, readonly string[]>();
  const copiedInputs = new Set<string>();
  const resolveModulePreloadDependencies: ResolveModulePreloadDependenciesFn = (
    filename,
    deps,
    context,
  ) => {
    if (context.hostType !== "js") {
      return deps;
    }
    // The executing importer has already loaded its whole static JS graph.
    // Keep the lazy target, its other dependencies, and Vite's CSS preloads.
    const loaded = new Set<string>();
    const imports = [...(staticImports.get(context.hostId) ?? [])];
    for (const dependency of imports) {
      if (!loaded.has(dependency)) {
        loaded.add(dependency);
        imports.push(...(staticImports.get(dependency) ?? []));
      }
    }
    // Without stylesheet waits, import() immediately fetches its own target.
    // Keep the target preload when CSS would otherwise delay that request.
    const waitsForStyles = deps.some((dep) => dep.endsWith(".css"));
    return deps.filter((dep) => !loaded.has(dep) && (waitsForStyles || dep !== filename));
  };
  return {
    base,
    worker: {
      format: "iife",
      plugins: () => [mermaidClassicBundlePlugin()],
      rolldownOptions: {
        output: { codeSplitting: false },
      },
    },
    define: {
      ...controlUiRuntimeDefines(options.command, buildInfo),
      "globalThis.OPENCLAW_UI_DEV_GATEWAY": devGateway
        ? JSON.stringify(devGateway.gateway)
        : "undefined",
    },
    publicDir: path.resolve(here, "public"),
    css: {
      postcss: {
        plugins: [controlUiHoverGuardPlugin()],
      },
    },
    optimizeDeps: {
      include: ["ipaddr.js", ...commonJsOptimizeDeps],
    },
    resolve: {
      alias: [
        { find: "json5", replacement: json5EsmPath },
        ...resolveExternalPackageAliasesForVite(),
        ...resolveSourcePackageAliasesForVite(),
        ...resolveTsconfigPathAliasesForVite(),
      ],
    },
    build: {
      target: ["chrome147", "firefox150", "safari26.2"],
      outDir: options.outDir ?? outDir,
      emptyOutDir: true,
      // The canonical sidecar performance report already measures shipped compressed bytes.
      reportCompressedSize: false,
      // Release packages omit maps; keep generating them without advertising dead URLs.
      // Source builds retain automatic debugger discovery.
      sourcemap: buildInfo.release ? "hidden" : true,
      modulePreload: {
        polyfill: true,
        resolveDependencies: resolveModulePreloadDependencies,
      },
      rolldownOptions: {
        // Explicit groups do not absorb each other's dependencies. These settings
        // preserve execution order while keeping the startup chunks bounded.
        preserveEntrySignatures: "allow-extension",
        output: {
          codeSplitting: controlUiCodeSplitting,
          strictExecutionOrder: true,
        },
      },
      // Keep CI/onboard logs clean; the app chunk is split into stable runtime buckets above.
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: devGateway ? "127.0.0.1" : true,
      port: 5173,
      strictPort: true,
      // Chokidar selects FSEvents before reading its environment override on macOS.
      ...(usePolling ? { watch: { usePolling: true } } : {}),
      ...(devGateway ? { proxy: devGateway.proxy } : {}),
    },
    plugins: [
      controlUiSolidPlugin(),
      mermaidClassicBundlePlugin(),
      controlUiIsolatedDesktopRuntimePlugin(),
      {
        name: "control-ui-static-import-preloads",
        generateBundle(_options, bundle) {
          staticImports.clear();
          for (const chunk of Object.values(bundle)) {
            if (chunk.type === "chunk") {
              staticImports.set(chunk.fileName, chunk.imports);
            }
          }
        },
      },
      controlUiSocialCardPlugin(),
      controlUiLocaleModulesPlugin(),
      controlUiPluginDistributionsPlugin(repoRoot, copiedInputs),
      controlUiBootPreloadsPlugin(),
      controlUiBuildOutputPlugin(buildInfo, copiedInputs),
      {
        name: "control-ui-dev-stubs",
        configureServer(server) {
          if (devGateway) {
            return;
          }
          server.middlewares.use(bootstrapConfigPath, (_req, res) => {
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
}
