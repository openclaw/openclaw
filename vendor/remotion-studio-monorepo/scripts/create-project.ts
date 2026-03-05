#!/usr/bin/env -S node
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import readline from "readline";

type Answers = {
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  install: boolean;
  compositionId: string;
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const question = (q: string) =>
  new Promise<string>((res) => rl.question(q, (a) => res(a)));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const repoRoot = root; // scripts directory is at <repo>/scripts

const appsDir = path.resolve(repoRoot, "apps");
const defaultTemplateDir = path.join(appsDir, "_template");
const threeDTemplateDir = path.join(appsDir, "3D-template");
const rootPkgPath = path.join(repoRoot, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

const remotionVersion =
  rootPkg.devDependencies?.["@remotion/cli"] ||
  rootPkg.dependencies?.remotion ||
  rootPkg.devDependencies?.remotion ||
  rootPkg.dependencies?.["@remotion/cli"] ||
  null;

if (!remotionVersion) {
  console.warn(
    "[create-project] Remotion version not found in root package.json; using template defaults.",
  );
}

type TemplateKey = "default" | "3d";

type AppMeta = {
  title: string;
  description: string;
  tags: string[];
  thumbnail: string;
  lastRendered: string | null;
  category: string;
};

function toDisplayTitle(name: string) {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferCategory(name: string, templateKey: TemplateKey) {
  const lower = name.toLowerCase();
  if (templateKey === "3d") return "3d";
  if (/(example|demo|showcase)/.test(lower)) return "example";
  if (/(template|starter|boilerplate)/.test(lower)) return "template";
  return "general";
}

function inferTags(name: string, templateKey: TemplateKey, category: string) {
  const tags = new Set<string>(["remotion", category]);
  tags.add(templateKey === "3d" ? "3d" : "2d");
  if (templateKey === "3d") tags.add("template");

  const nameTags = name
    .split(/[^a-z0-9]+/i)
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length >= 2);
  for (const tag of nameTags) {
    tags.add(tag);
  }

  return Array.from(tags);
}

function buildAppMeta(name: string, templateKey: TemplateKey): AppMeta {
  const category = inferCategory(name, templateKey);
  const templateLabel =
    templateKey === "3d" ? "3D template" : "default template";
  return {
    title: toDisplayTitle(name),
    description: `${toDisplayTitle(name)} generated from ${templateLabel}.`,
    tags: inferTags(name, templateKey, category),
    thumbnail: "public/thumbnail.svg",
    lastRendered: null,
    category,
  };
}

function buildDefaultThumbnailSvg(
  name: string,
  templateKey: TemplateKey,
): string {
  const title = toDisplayTitle(name).slice(0, 28);
  const category = templateKey === "3d" ? "3D" : "2D";
  const bgA = templateKey === "3d" ? "#1d4ed8" : "#0f766e";
  const bgB = templateKey === "3d" ? "#7c3aed" : "#2563eb";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-label="${title}">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${bgA}" />
      <stop offset="100%" stop-color="${bgB}" />
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#g)" />
  <circle cx="1070" cy="120" r="220" fill="rgba(255,255,255,0.08)" />
  <circle cx="180" cy="620" r="260" fill="rgba(255,255,255,0.08)" />
  <text x="80" y="520" fill="#f8fafc" font-size="72" font-family="Inter, system-ui, sans-serif" font-weight="700">${title}</text>
  <text x="84" y="586" fill="rgba(248,250,252,0.92)" font-size="34" font-family="Inter, system-ui, sans-serif">Remotion Forge ${category}</text>
</svg>`;
}

function parseArgs(argv: string[]) {
  let nameArg: string | undefined;
  let templateKey: TemplateKey | undefined;
  let destArg: string | undefined;
  let yes = false;
  let noInstall = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") {
      yes = true;
      continue;
    }
    if (a === "--no-install") {
      noInstall = true;
      continue;
    }
    if (a === "--template" || a === "-t") {
      const v = argv[i + 1];
      if (v) {
        if (/^3d$/i.test(v) || /^3D-template$/.test(v)) templateKey = "3d";
        else templateKey = "default";
        i++;
        continue;
      }
    }
    if (a === "--dest" || a === "--out" || a === "-o") {
      const v = argv[i + 1];
      if (v) {
        destArg = path.resolve(process.cwd(), v);
        i++;
        continue;
      }
    }
    if (!a.startsWith("-") && !nameArg) {
      nameArg = a;
      continue;
    }
  }
  return { nameArg, templateKey, destArg, yes, noInstall };
}

async function ensureExists(p: string) {
  await fsp.mkdir(p, { recursive: true });
}

async function copyDir(src: string, dest: string) {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  await ensureExists(dest);
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isSymbolicLink()) {
      const target = await fsp.readlink(s);
      await fsp.symlink(target, d);
    } else {
      await fsp.copyFile(s, d);
    }
  }
}

function alignRemotionDeps(pkg: Record<string, any>) {
  if (!remotionVersion) return;
  const sections: Array<
    "dependencies" | "devDependencies" | "peerDependencies"
  > = ["dependencies", "devDependencies", "peerDependencies"];
  for (const section of sections) {
    const block = pkg[section];
    if (!block) continue;
    for (const dep of Object.keys(block)) {
      if (dep === "remotion" || dep.startsWith("@remotion/")) {
        block[dep] = remotionVersion;
      }
    }
  }
}

const TEXT_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".txt",
  ".css",
  ".scss",
  ".html",
  ".yml",
  ".yaml",
]);

async function replaceInFiles(
  dir: string,
  replacements: Record<string, string>,
) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      await replaceInFiles(full, replacements);
    } else {
      const ext = path.extname(ent.name).toLowerCase();
      if (!TEXT_EXTS.has(ext)) continue;
      try {
        let content = await fsp.readFile(full, "utf8");
        let changed = false;
        for (const [from, to] of Object.entries(replacements)) {
          const before = content;
          content = content.split(from).join(to);
          if (content !== before) changed = true;
        }
        if (changed) await fsp.writeFile(full, content, "utf8");
      } catch {
        // ignore binary/unreadable files
      }
    }
  }
}

async function renameIfNeeded(dir: string, oldStr: string, newStr: string) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const oldPath = path.join(dir, ent.name);
    let newPath = oldPath;
    if (ent.name.includes(oldStr)) {
      newPath = path.join(dir, ent.name.replaceAll(oldStr, newStr));
      await fsp.rename(oldPath, newPath);
    }
    if (ent.isDirectory()) {
      await renameIfNeeded(newPath, oldStr, newStr);
    }
  }
}

async function main() {
  const {
    nameArg,
    templateKey: cliTemplate,
    destArg,
    yes,
    noInstall,
  } = parseArgs(process.argv.slice(2));
  const useDefaults = yes;
  const defaultName = nameArg || "new-app";
  const nameAns = nameArg
    ? nameArg
    : useDefaults
      ? defaultName
      : (await question(`Project name (@studio/<name>) [${defaultName}]: `)) ||
        defaultName;
  const normName = nameAns.trim();
  if (!/^[a-z0-9-_]+$/i.test(normName)) {
    console.error("Invalid name. Use letters, numbers, dash, underscore.");
    process.exit(1);
  }
  const width = useDefaults
    ? 1920
    : Number((await question("Width [1920]: ")) || "1920");
  const height = useDefaults
    ? 1080
    : Number((await question("Height [1080]: ")) || "1080");
  const fps = useDefaults ? 30 : Number((await question("FPS [30]: ")) || "30");
  const duration = useDefaults
    ? 180
    : Number((await question("Duration in frames [180]: ")) || "180");
  const compIdInput = useDefaults
    ? ""
    : (await question("Composition ID [Main]: ")).trim();
  const compositionId = compIdInput === "" ? "Main" : compIdInput;
  let templateKey: TemplateKey = cliTemplate ?? "default";
  if (!cliTemplate && !useDefaults) {
    const use3d = (await question("Use 3D template? [y/N]: "))
      .trim()
      .toLowerCase();
    templateKey = use3d === "y" || use3d === "yes" ? "3d" : "default";
  }
  const installAns = noInstall
    ? "n"
    : useDefaults
      ? "y"
      : (await question("Run pnpm install now? [Y/n]: ")).trim().toLowerCase();
  const answers: Answers = {
    name: normName,
    width: Number.isFinite(width) ? width : 1920,
    height: Number.isFinite(height) ? height : 1080,
    fps: Number.isFinite(fps) ? fps : 30,
    duration: Number.isFinite(duration) ? duration : 180,
    install: installAns === "" || installAns === "y" || installAns === "yes",
    compositionId,
  };

  rl.close();

  const destDir = destArg ? destArg : path.join(appsDir, answers.name);
  if (fs.existsSync(destDir)) {
    console.error(`Directory already exists: ${destDir}`);
    process.exit(1);
  }

  console.log(`Creating project at ${destDir} ...`);
  const templateDir =
    templateKey === "3d" ? threeDTemplateDir : defaultTemplateDir;
  await copyDir(templateDir, destDir);

  // Update package.json
  const pkgPath = path.join(destDir, "package.json");
  const pkg = JSON.parse(await fsp.readFile(pkgPath, "utf8"));
  pkg.name = `@studio/${answers.name}`;
  if (pkg.scripts?.build) {
    pkg.scripts.build = `remotion render src/index.ts ${answers.compositionId} out/${answers.name}.mp4`;
  }
  alignRemotionDeps(pkg);
  await fsp.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // Replace placeholders in Root.tsx (_template) or constants in 3D-template
  const rootTsxPath = path.join(destDir, "src", "Root.tsx");
  let rootTsx = await fsp.readFile(rootTsxPath, "utf8");
  if (templateKey === "default") {
    rootTsx = rootTsx
      .replace(/__WIDTH__/g, String(answers.width))
      .replace(/__HEIGHT__/g, String(answers.height))
      .replace(/__FPS__/g, String(answers.fps))
      .replace(/__DURATION__/g, String(answers.duration));
  } else {
    // 3D-template uses numeric constants; patch them
    rootTsx = rootTsx
      .replace(/const\s+WIDTH\s*=\s*\d+\s*;/, `const WIDTH = ${answers.width};`)
      .replace(
        /const\s+HEIGHT\s*=\s*\d+\s*;/,
        `const HEIGHT = ${answers.height};`,
      )
      .replace(/const\s+FPS\s*=\s*\d+\s*;/, `const FPS = ${answers.fps};`)
      .replace(
        /const\s+DURATION\s*=\s*\d+\s*;/,
        `const DURATION = ${answers.duration};`,
      );
  }
  // Update first Composition id to the chosen compositionId (default: Main)
  rootTsx = rootTsx.replace(
    /id\s*=\s*(["'])[A-Za-z0-9_-]+\1/,
    `id="${answers.compositionId}"`,
  );
  await fsp.writeFile(rootTsxPath, rootTsx);

  // Replace placeholders in project.config.ts if present; or patch numbers for 3D-template
  const projCfgPath = path.join(destDir, "src", "project.config.ts");
  if (fs.existsSync(projCfgPath)) {
    let projCfg = await fsp.readFile(projCfgPath, "utf8");
    if (templateKey === "default") {
      projCfg = projCfg
        .replace(/__WIDTH__/g, String(answers.width))
        .replace(/__HEIGHT__/g, String(answers.height))
        .replace(/__FPS__/g, String(answers.fps))
        .replace(/__DURATION__/g, String(answers.duration));
    } else {
      projCfg = projCfg
        .replace(/width:\s*\d+\s*,/, `width: ${answers.width},`)
        .replace(/height:\s*\d+\s*,/, `height: ${answers.height},`)
        .replace(/fps:\s*\d+\s*,/, `fps: ${answers.fps},`)
        .replace(
          /durationInFrames:\s*\d+\s*,?/,
          `durationInFrames: ${answers.duration},`,
        );
    }
    await fsp.writeFile(projCfgPath, projCfg);
  }

  // Ensure public directory
  await ensureExists(path.join(destDir, "public"));
  const thumbnailPath = path.join(destDir, "public", "thumbnail.svg");
  if (!fs.existsSync(thumbnailPath)) {
    await fsp.writeFile(
      thumbnailPath,
      `${buildDefaultThumbnailSvg(answers.name, templateKey)}\n`,
      "utf8",
    );
  }
  // Scaffold public/assets with commonly used subfolders
  // images, audio, video, fonts, css, data(json), lottie(json)
  const assetsBase = path.join(destDir, "public", "assets");
  const assetDirs = [
    "images",
    "audio",
    "video",
    "fonts",
    "css",
    "data",
    "lottie",
  ].map((n) => path.join(assetsBase, n));
  for (const d of assetDirs) {
    await ensureExists(d);
    try {
      await fsp.writeFile(path.join(d, ".gitkeep"), "");
    } catch {}
  }

  // Optional source-side styles directory for CSS imports via bundler
  const srcStyles = path.join(destDir, "src", "styles");
  await ensureExists(srcStyles);
  try {
    await fsp.writeFile(path.join(srcStyles, ".gitkeep"), "");
  } catch {}

  // Post-copy placeholder replacement across the project
  await replaceInFiles(destDir, {
    __PACKAGE__: `@studio/${answers.name}`,
    __APP_NAME__: answers.name,
  });

  // Rename files/directories that might contain a concrete name from past templates
  await renameIfNeeded(destDir, "toki-mv", answers.name);
  await renameIfNeeded(destDir, "__APP_NAME__", answers.name);

  // Ensure app meta always exists with required keys.
  const appMetaPath = path.join(destDir, "app.meta.json");
  const appMeta = buildAppMeta(answers.name, templateKey);
  await fsp.writeFile(
    appMetaPath,
    JSON.stringify(appMeta, null, 2) + "\n",
    "utf8",
  );

  console.log("Project created successfully.");

  if (answers.install) {
    const insideWorkspace = destDir.startsWith(appsDir + path.sep);
    const installCwd = insideWorkspace ? repoRoot : destDir;
    console.log(
      `Running pnpm install (${insideWorkspace ? "workspace root" : "new app"})...`,
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn("pnpm", ["install"], {
        cwd: installCwd,
        stdio: "inherit",
        shell: true,
      });
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`pnpm install failed with code ${code}`)),
      );
    }).catch((e) => {
      console.warn(String(e));
      console.warn(
        "Install failed or skipped. You can run it later: pnpm install",
      );
    });
  }

  const nextDevCmd = destArg
    ? `pnpm -C ${destDir} run dev`
    : `pnpm -C apps/${answers.name} run dev`;
  const nextBuildCmd = destArg
    ? `pnpm -C ${destDir} run build`
    : `pnpm -C apps/${answers.name} run build`;
  console.log(`Next steps:\n  - ${nextDevCmd}\n  - ${nextBuildCmd}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
