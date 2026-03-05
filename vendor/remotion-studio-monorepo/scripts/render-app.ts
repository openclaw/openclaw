#!/usr/bin/env tsx
/**
 * Render a Remotion app to video
 */

import { execSync, spawnSync } from "child_process";
import {
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import * as readline from "readline";
import { tmpdir } from "os";

interface RenderOptions {
  app?: string;
  composition?: string;
  output?: string;
  concurrency?: number;
  quality?: number;
  skipBuildPackages?: boolean;
}

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message: string, color: keyof typeof COLORS = "reset") {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type AppMeta = {
  title: string;
  description: string;
  tags: string[];
  thumbnail: string;
  lastRendered: string | null;
  category: string;
};

function toDisplayTitle(appName: string): string {
  return appName
    .split(/[/-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeAppMeta(appName: string, input: unknown): AppMeta {
  const fallback: AppMeta = {
    title: toDisplayTitle(appName),
    description: `${toDisplayTitle(appName)} created with Remotion Forge.`,
    tags: ["remotion", "forge"],
    thumbnail: "public/thumbnail.svg",
    lastRendered: null,
    category: "general",
  };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fallback;
  }

  const raw = input as Record<string, unknown>;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === "string")
    : fallback.tags;

  return {
    title:
      typeof raw.title === "string" && raw.title.trim().length > 0
        ? raw.title.trim()
        : fallback.title,
    description:
      typeof raw.description === "string" && raw.description.trim().length > 0
        ? raw.description.trim()
        : fallback.description,
    tags: tags.length > 0 ? tags : fallback.tags,
    thumbnail:
      typeof raw.thumbnail === "string" && raw.thumbnail.trim().length > 0
        ? raw.thumbnail.trim()
        : fallback.thumbnail,
    lastRendered:
      typeof raw.lastRendered === "string" && raw.lastRendered.trim().length > 0
        ? raw.lastRendered
        : null,
    category:
      typeof raw.category === "string" && raw.category.trim().length > 0
        ? raw.category.trim()
        : fallback.category,
  };
}

function updateLastRendered(
  appPath: string,
  appName: string,
  renderedAt: string,
): AppMeta {
  const metaPath = join(appPath, "app.meta.json");
  let meta: AppMeta = normalizeAppMeta(appName, null);

  if (existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as unknown;
      meta = normalizeAppMeta(appName, parsed);
    } catch {
      log("Could not parse app.meta.json. Recreating file.", "yellow");
    }
  }

  meta.lastRendered = renderedAt;
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  log(`  app.meta.json updated: lastRendered=${renderedAt}`, "cyan");
  return meta;
}

function countRenderedOutputs(appPath: string): number {
  const outDir = join(appPath, "out");
  if (!existsSync(outDir)) {
    return 0;
  }

  return readdirSync(outDir).filter((file) =>
    /\.(mp4|mov|webm|gif)$/i.test(file),
  ).length;
}

function resolveAchievement(renderCount: number): {
  name: string;
  description: string;
} {
  if (renderCount <= 1) {
    return {
      name: "First Spark",
      description: "最初の作品を鍛造しました。Forgeへようこそ。",
    };
  }

  if (renderCount < 5) {
    return {
      name: "Momentum Builder",
      description: "制作リズムが立ち上がっています。次の作品へ。",
    };
  }

  if (renderCount < 15) {
    return {
      name: "Creative Blacksmith",
      description: "安定して作品を生み出せています。火力良好です。",
    };
  }

  return {
    name: "Forge Master",
    description: "継続制作の達人です。スタジオの炉は常に燃焼中。",
  };
}

function tryOpenBrowser(targetPath: string): boolean {
  const result =
    process.platform === "darwin"
      ? spawnSync("open", [targetPath], { stdio: "ignore", windowsHide: true })
      : process.platform === "win32"
        ? spawnSync("cmd", ["/c", "start", "", targetPath], {
            stdio: "ignore",
            windowsHide: true,
          })
        : spawnSync("xdg-open", [targetPath], {
            stdio: "ignore",
            windowsHide: true,
          });

  if (result.error) {
    return false;
  }

  return result.status === 0;
}

function buildCelebrationPage(params: {
  appName: string;
  compositionId: string;
  outputPath: string;
  renderedAt: string;
  achievementName: string;
  achievementDescription: string;
}): string {
  const appName = escapeHtml(params.appName);
  const compositionId = escapeHtml(params.compositionId || "(unspecified)");
  const outputPath = escapeHtml(params.outputPath);
  const outputName = escapeHtml(basename(params.outputPath));
  const renderedAt = escapeHtml(params.renderedAt);
  const achievementName = escapeHtml(params.achievementName);
  const achievementDescription = escapeHtml(params.achievementDescription);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Render Achievement</title>
  <style>
    :root {
      --bg-1: #0f172a;
      --bg-2: #1e293b;
      --card: rgba(15, 23, 42, 0.78);
      --line: rgba(148, 163, 184, 0.35);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --ok: #22c55e;
      --accent: #38bdf8;
      --gold: #fbbf24;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Inter", "Segoe UI", sans-serif;
      color: var(--text);
      min-height: 100vh;
      overflow: hidden;
      background:
        radial-gradient(circle at 20% 20%, rgba(56, 189, 248, 0.25), transparent 38%),
        radial-gradient(circle at 80% 10%, rgba(251, 191, 36, 0.2), transparent 36%),
        linear-gradient(135deg, var(--bg-1), var(--bg-2));
      display: grid;
      place-items: center;
    }
    #sky {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }
    .panel {
      width: min(760px, calc(100vw - 32px));
      border: 1px solid var(--line);
      background: var(--card);
      backdrop-filter: blur(6px);
      border-radius: 20px;
      padding: 28px;
      box-shadow: 0 24px 80px rgba(2, 6, 23, 0.6);
      z-index: 1;
      animation: rise 700ms ease-out;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 4vw, 44px);
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .subtitle {
      margin: 0 0 20px;
      color: var(--muted);
      font-size: 14px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid rgba(34, 197, 94, 0.4);
      background: rgba(34, 197, 94, 0.1);
      color: #bbf7d0;
      border-radius: 999px;
      padding: 8px 14px;
      font-size: 13px;
      margin-bottom: 18px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      background: rgba(15, 23, 42, 0.46);
      min-height: 96px;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .value {
      word-break: break-word;
      font-weight: 600;
      line-height: 1.4;
    }
    .gold {
      color: var(--gold);
      text-shadow: 0 0 16px rgba(251, 191, 36, 0.5);
    }
    @keyframes rise {
      0% { transform: translateY(14px) scale(0.98); opacity: 0; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }
  </style>
</head>
<body>
  <canvas id="sky"></canvas>
  <main class="panel">
    <div class="badge">✓ Render Complete</div>
    <h1>Achievement Unlocked</h1>
    <p class="subtitle">Great work. Your Remotion render has been forged successfully.</p>
    <div class="grid">
      <article class="card" style="grid-column: 1 / -1;">
        <div class="label">Achievement</div>
        <div class="value gold">${achievementName}</div>
        <div class="value" style="margin-top:8px; font-weight:500;">${achievementDescription}</div>
      </article>
      <article class="card">
        <div class="label">App</div>
        <div class="value">${appName}</div>
      </article>
      <article class="card">
        <div class="label">Composition</div>
        <div class="value">${compositionId}</div>
      </article>
      <article class="card">
        <div class="label">Output</div>
        <div class="value">${outputName}</div>
      </article>
      <article class="card">
        <div class="label">Rendered At (UTC)</div>
        <div class="value">${renderedAt}</div>
      </article>
      <article class="card" style="grid-column: 1 / -1;">
        <div class="label">Path</div>
        <div class="value gold">${outputPath}</div>
      </article>
    </div>
  </main>
  <script>
    const canvas = document.getElementById("sky");
    const ctx = canvas.getContext("2d");

    const confetti = [];
    const fireworks = [];
    const colors = ["#38bdf8", "#fbbf24", "#22c55e", "#f472b6", "#a78bfa"];

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    function createConfetti() {
      confetti.length = 0;
      for (let i = 0; i < 180; i++) {
        confetti.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height - canvas.height,
          w: 4 + Math.random() * 5,
          h: 7 + Math.random() * 8,
          vy: 1 + Math.random() * 2.8,
          vx: -1 + Math.random() * 2,
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 0.2,
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      }
    }

    function launchFirework() {
      const cx = 80 + Math.random() * (canvas.width - 160);
      const cy = 80 + Math.random() * (canvas.height * 0.4);
      for (let i = 0; i < 54; i++) {
        const angle = (Math.PI * 2 * i) / 54;
        const speed = 1 + Math.random() * 3.5;
        fireworks.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 58 + Math.random() * 30,
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      }
    }

    function tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const piece of confetti) {
        piece.x += piece.vx;
        piece.y += piece.vy;
        piece.rot += piece.vr;

        if (piece.y > canvas.height + 20) {
          piece.y = -20;
          piece.x = Math.random() * canvas.width;
        }
        if (piece.x < -20) piece.x = canvas.width + 20;
        if (piece.x > canvas.width + 20) piece.x = -20;

        ctx.save();
        ctx.translate(piece.x, piece.y);
        ctx.rotate(piece.rot);
        ctx.fillStyle = piece.color;
        ctx.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
        ctx.restore();
      }

      for (let i = fireworks.length - 1; i >= 0; i--) {
        const spark = fireworks[i];
        spark.x += spark.vx;
        spark.y += spark.vy;
        spark.vy += 0.015;
        spark.life -= 1;

        if (spark.life <= 0) {
          fireworks.splice(i, 1);
          continue;
        }

        ctx.globalAlpha = Math.max(0, spark.life / 90);
        ctx.fillStyle = spark.color;
        ctx.beginPath();
        ctx.arc(spark.x, spark.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      requestAnimationFrame(tick);
    }

    window.addEventListener("resize", resize);
    resize();
    createConfetti();
    launchFirework();
    setInterval(launchFirework, 900);
    requestAnimationFrame(tick);
  </script>
</body>
</html>`;
}

function openCelebrationPage(params: {
  appName: string;
  compositionId: string;
  outputPath: string;
  renderedAt: string;
  achievementName: string;
  achievementDescription: string;
}) {
  try {
    const pagePath = join(
      tmpdir(),
      `remotion-forge-achievement-${Date.now()}.html`,
    );
    writeFileSync(pagePath, buildCelebrationPage(params), "utf-8");

    if (tryOpenBrowser(pagePath)) {
      log("  Opened achievement page in browser", "cyan");
    } else {
      log("  Could not open browser automatically", "yellow");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    log(`  Failed to prepare achievement page: ${message}`, "yellow");
  }
}

function getAvailableApps(): string[] {
  const appsDir = join(process.cwd(), "apps");
  if (!existsSync(appsDir)) return [];

  const collected: string[] = [];
  const walk = (dir: string, relDir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(dir, entry);
      if (!statSync(fullPath).isDirectory()) continue;
      if (entry === "node_modules") continue;

      const relPath = relDir ? `${relDir}/${entry}` : entry;
      const hasPackageJson = existsSync(join(fullPath, "package.json"));
      if (hasPackageJson) {
        if (
          !entry.startsWith("_") &&
          !entry.toLowerCase().includes("template") &&
          !relPath.toLowerCase().includes("/_") &&
          resolveEntryPoint(fullPath)
        ) {
          collected.push(relPath);
        }
        continue;
      }

      walk(fullPath, relPath);
    }
  };

  walk(appsDir, "");
  return collected.sort();
}

function resolveEntryPoint(appPath: string): string | null {
  const candidates = [
    "src/index.ts",
    "src/index.tsx",
    "src/main.ts",
    "src/main.tsx",
    "index.ts",
    "index.tsx",
  ];

  for (const candidate of candidates) {
    if (existsSync(join(appPath, candidate))) {
      return candidate;
    }
  }

  return null;
}

function getCompositions(appPath: string, entryPoint: string): string[] {
  try {
    // Try to get compositions using remotion compositions command
    const output = execSync(
      `pnpm exec remotion compositions ${JSON.stringify(entryPoint)} --quiet`,
      {
        cwd: appPath,
        encoding: "utf-8",
      },
    );

    // Parse composition IDs from output
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const candidate = lines.at(-1) ?? "";
    const compositions = candidate
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => /^[A-Za-z0-9_-]+$/.test(token));

    return [...new Set(compositions)];
  } catch {
    log("Could not auto-detect compositions", "yellow");
    return [];
  }
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${COLORS.cyan}${question}${COLORS.reset}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function selectApp(availableApps: string[]): Promise<string> {
  log("\n📋 Available apps:", "cyan");
  availableApps.forEach((app, index) => {
    log(`  ${index + 1}. ${app}`, "yellow");
  });

  const answer = await promptUser(`\nSelect app (1-${availableApps.length}): `);
  const index = parseInt(answer, 10) - 1;

  if (index >= 0 && index < availableApps.length) {
    return availableApps[index];
  } else {
    log("Invalid selection", "red");
    process.exit(1);
  }
}

async function selectComposition(compositions: string[]): Promise<string> {
  if (compositions.length === 0) {
    return await promptUser("Enter composition ID: ");
  }

  log("\n🎬 Available compositions:", "cyan");
  compositions.forEach((comp, index) => {
    log(`  ${index + 1}. ${comp}`, "yellow");
  });

  const answer = await promptUser(
    `\nSelect composition (1-${compositions.length}): `,
  );
  const index = parseInt(answer, 10) - 1;

  if (index >= 0 && index < compositions.length) {
    return compositions[index];
  } else {
    log("Invalid selection", "red");
    process.exit(1);
  }
}

async function renderApp(options: RenderOptions) {
  const availableApps = getAvailableApps();

  if (availableApps.length === 0) {
    log("No apps found in the apps/ directory", "red");
    log("Create an app using: pnpm create:project", "yellow");
    process.exit(1);
  }

  // Select app
  let appName = options.app;
  if (!appName) {
    if (availableApps.length === 1) {
      appName = availableApps[0];
      log(`Using the only available app: ${appName}`, "green");
    } else {
      appName = await selectApp(availableApps);
    }
  } else if (!availableApps.includes(appName)) {
    log(`App "${appName}" not found`, "red");
    process.exit(1);
  }

  const appPath = join(process.cwd(), "apps", appName);
  const entryPoint = resolveEntryPoint(appPath);
  if (!entryPoint) {
    log(`Could not find Remotion entry point in ${appName}`, "red");
    process.exit(1);
  }

  if (!options.skipBuildPackages) {
    log("\n🏗️ Building shared packages...", "blue");
    try {
      execSync("pnpm build:packages", {
        cwd: process.cwd(),
        stdio: "inherit",
      });
    } catch {
      log("Failed to build shared packages", "red");
      process.exit(1);
    }
  }

  // Select composition
  let compositionId = options.composition;
  if (!compositionId) {
    log(`\n🔍 Detecting compositions in ${appName}...`, "blue");
    const compositions = getCompositions(appPath, entryPoint);
    compositionId = await selectComposition(compositions);
  }

  // Build output path
  const outputPath =
    options.output ||
    join(appPath, "out", `${compositionId}-${Date.now()}.mp4`);

  // Build render command
  const renderArgs = [
    "remotion",
    "render",
    entryPoint,
    compositionId,
    outputPath,
  ];

  if (options.concurrency) {
    renderArgs.push("--concurrency", options.concurrency.toString());
  }

  if (options.quality) {
    renderArgs.push("--quality", options.quality.toString());
  }

  log("\n🎬 Starting render...", "blue");
  log(`  App: ${appName}`, "cyan");
  log(`  Entry: ${entryPoint}`, "cyan");
  log(`  Composition: ${compositionId}`, "cyan");
  log(`  Output: ${outputPath}`, "cyan");

  try {
    execSync(renderArgs.join(" "), {
      cwd: appPath,
      stdio: "inherit",
    });

    const renderedAt = new Date().toISOString();
    updateLastRendered(appPath, appName, renderedAt);
    const renderCount = countRenderedOutputs(appPath);
    const achievement = resolveAchievement(renderCount);
    openCelebrationPage({
      appName,
      compositionId: compositionId || "(unspecified)",
      outputPath,
      renderedAt,
      achievementName: achievement.name,
      achievementDescription: achievement.description,
    });

    log("\n✓ Render complete!", "green");
    log(`  Output: ${outputPath}`, "cyan");
  } catch {
    log("\n✗ Render failed", "red");
    process.exit(1);
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  log("\n🎬 Render Script", "blue");
  log("\nUsage: pnpm render [options]", "cyan");
  log("\nOptions:", "cyan");
  log("  --app <name>           App name to render", "yellow");
  log("  --composition <id>     Composition ID to render", "yellow");
  log("  --output <path>        Output file path", "yellow");
  log("  --concurrency <num>    Number of threads to use", "yellow");
  log("  --quality <num>        Video quality (0-100)", "yellow");
  log("  --skip-build-packages  Skip package build before rendering", "yellow");
  log("  -h, --help             Show this help message", "yellow");
  log("\nExamples:", "cyan");
  log("  pnpm render", "yellow");
  log("  pnpm render --app my-app", "yellow");
  log("  pnpm render --app my-app --composition Main", "yellow");
  log("  pnpm render --app my-app --composition Main --quality 80", "yellow");
  process.exit(0);
}

const options: RenderOptions = {
  app: args.includes("--app") ? args[args.indexOf("--app") + 1] : undefined,
  composition: args.includes("--composition")
    ? args[args.indexOf("--composition") + 1]
    : undefined,
  output: args.includes("--output")
    ? args[args.indexOf("--output") + 1]
    : undefined,
  concurrency: args.includes("--concurrency")
    ? parseInt(args[args.indexOf("--concurrency") + 1], 10)
    : undefined,
  quality: args.includes("--quality")
    ? parseInt(args[args.indexOf("--quality") + 1], 10)
    : undefined,
  skipBuildPackages: args.includes("--skip-build-packages"),
};

renderApp(options).catch((error) => {
  log(`Error: ${error.message}`, "red");
  process.exit(1);
});
