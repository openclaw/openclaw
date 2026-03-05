import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  getActiveDevServer,
  listActiveDevServers,
  removeDevServer,
  upsertDevServer,
} from "@/lib/forge-runtime";
import { moveProjectToTrash } from "@/lib/forge-trash";
import { resolveAppsRoot } from "@/lib/project-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ForgeAction = "dev" | "stop-dev" | "render" | "delete-project";

function hasTraversalPattern(value: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(value);
}

function isWithinPath(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function getPnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function terminateProcessTree(pid: number): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0;
  }

  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    // Fall through to direct PID kill.
  }

  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function createLogFile(
  action: ForgeAction,
  appId: string,
): {
  outFd: number;
  logPath: string;
} {
  const logsDir = path.join(tmpdir(), "remotion-forge-logs");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeAppId = appId.replace(/[\\/]/g, "_");
  const logPath = path.join(logsDir, `${action}-${safeAppId}-${timestamp}.log`);
  return {
    outFd: openSync(logPath, "a"),
    logPath,
  };
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
    if (existsSync(path.join(appPath, candidate))) {
      return candidate;
    }
  }

  return null;
}

function readDevScript(appPath: string): string | null {
  const packageJsonPath = path.join(appPath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      scripts?: Record<string, string | undefined>;
    };
    const script = parsed.scripts?.dev;
    return typeof script === "string" ? script : null;
  } catch {
    return null;
  }
}

function resolveDevArgs(appPath: string, port: number): string[] {
  const devScript = readDevScript(appPath)?.toLowerCase() ?? "";
  if (devScript.includes("remotion studio")) {
    return ["exec", "remotion", "studio", "--port", String(port)];
  }

  return ["run", "dev", "--", "--port", String(port)];
}

function detectCompositions(appPath: string, entryPoint: string): string[] {
  const command = getPnpmCommand();
  const result = spawnSync(
    command,
    ["exec", "remotion", "compositions", entryPoint, "--quiet"],
    {
      cwd: appPath,
      encoding: "utf8",
      shell: false,
    },
  );

  if (result.status !== 0) {
    return [];
  }

  const lines = (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.at(-1) ?? "";
  return candidate
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z0-9_-]+$/.test(token));
}

function chooseComposition(compositions: string[]): string {
  if (compositions.includes("Main")) {
    return "Main";
  }
  if (compositions.includes("TemplateMain")) {
    return "TemplateMain";
  }
  return compositions[0] ?? "Main";
}

async function findAvailablePort(
  startPort = 3400,
  maxTry = 100,
): Promise<number> {
  const canUsePort = (port: number) =>
    new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });

  for (let port = startPort; port < startPort + maxTry; port++) {
    if (await canUsePort(port)) {
      return port;
    }
  }

  throw new Error("No available port found.");
}

export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("appId");
  if (appId && hasTraversalPattern(appId)) {
    return NextResponse.json({ message: "Invalid appId." }, { status: 400 });
  }

  const devServers = await listActiveDevServers();

  if (appId) {
    const server = devServers.find((item) => item.appId === appId) ?? null;
    return NextResponse.json({
      ok: true,
      appId,
      devServer: server
        ? {
            ...server,
            url: `http://localhost:${server.port}`,
          }
        : null,
    });
  }

  return NextResponse.json({
    ok: true,
    devServers: devServers.map((server) => ({
      ...server,
      url: `http://localhost:${server.port}`,
    })),
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    appId?: string;
    action?: ForgeAction;
  } | null;

  const appId = body?.appId;
  const action = body?.action;

  if (!appId || typeof appId !== "string" || !action) {
    return NextResponse.json(
      { message: "appId and action are required." },
      { status: 400 },
    );
  }

  if (
    action !== "dev" &&
    action !== "stop-dev" &&
    action !== "render" &&
    action !== "delete-project"
  ) {
    return NextResponse.json({ message: "Invalid action." }, { status: 400 });
  }

  if (hasTraversalPattern(appId)) {
    return NextResponse.json({ message: "Invalid appId." }, { status: 400 });
  }

  if (action === "stop-dev") {
    const server = await getActiveDevServer(appId);
    if (!server) {
      await removeDevServer(appId);
      return NextResponse.json(
        { message: `No active dev server for ${appId}.` },
        { status: 404 },
      );
    }

    const stopped = terminateProcessTree(server.pid);

    await removeDevServer(appId);
    return NextResponse.json({
      ok: true,
      message: stopped
        ? `Dev server stopped for ${appId}`
        : `Dev process was not alive. Registry cleaned for ${appId}`,
      stopped,
      pid: server.pid,
    });
  }

  const appsRoot = resolveAppsRoot();
  const repoRoot = path.dirname(appsRoot);
  const appDir = path.resolve(appsRoot, appId);

  if (!isWithinPath(appDir, appsRoot)) {
    return NextResponse.json({ message: "Invalid app path." }, { status: 400 });
  }

  if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
    return NextResponse.json({ message: "App not found." }, { status: 404 });
  }

  if (action === "delete-project") {
    if (appId === "studio") {
      return NextResponse.json(
        { message: "The studio app cannot be deleted from the dashboard." },
        { status: 400 },
      );
    }

    const server = await getActiveDevServer(appId);
    let stoppedDev = false;
    if (server) {
      stoppedDev = terminateProcessTree(server.pid);
      await removeDevServer(appId);
    }

    await moveProjectToTrash({
      appsRoot,
      appId,
      appDir,
    });
    return NextResponse.json({
      ok: true,
      message: `Project moved to trash: ${appId}`,
      appId,
      stoppedDev,
    });
  }

  if (!existsSync(path.join(appDir, "package.json"))) {
    return NextResponse.json(
      { message: "App package.json not found." },
      { status: 404 },
    );
  }

  const command = getPnpmCommand();

  if (action === "dev") {
    const running = await getActiveDevServer(appId);
    if (running) {
      return NextResponse.json({
        ok: true,
        message: `Dev server already running for ${appId}`,
        alreadyRunning: true,
        pid: running.pid,
        port: running.port,
        logPath: running.logPath,
        url: `http://localhost:${running.port}`,
      });
    }

    const port = await findAvailablePort();
    await mkdir(path.join(tmpdir(), "remotion-forge-logs"), {
      recursive: true,
    });
    const { outFd, logPath } = createLogFile(action, appId);
    const child = spawn(command, resolveDevArgs(appDir, port), {
      cwd: appDir,
      detached: true,
      stdio: ["ignore", outFd, outFd],
      shell: false,
      env: {
        ...process.env,
        PORT: String(port),
        npm_config_port: undefined,
      },
    });
    child.unref();
    closeSync(outFd);

    if (!child.pid || child.pid <= 0) {
      return NextResponse.json(
        { message: `Failed to start dev server for ${appId}.` },
        { status: 500 },
      );
    }

    const startedAt = new Date().toISOString();
    await upsertDevServer({
      appId,
      pid: child.pid,
      port,
      startedAt,
      logPath,
    });

    return NextResponse.json({
      ok: true,
      message: `Dev server started for ${appId}`,
      pid: child.pid,
      port,
      startedAt,
      url: `http://localhost:${port}`,
      logPath,
    });
  }

  const entryPoint = resolveEntryPoint(appDir);
  if (!entryPoint) {
    return NextResponse.json(
      { message: "Could not resolve Remotion entry point." },
      { status: 400 },
    );
  }

  const compositions = detectCompositions(appDir, entryPoint);
  const composition = chooseComposition(compositions);
  await mkdir(path.join(tmpdir(), "remotion-forge-logs"), { recursive: true });
  const { outFd, logPath } = createLogFile(action, appId);

  const child = spawn(
    command,
    ["render", "--app", appId, "--composition", composition],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", outFd, outFd],
      shell: false,
    },
  );
  child.unref();
  closeSync(outFd);

  return NextResponse.json({
    ok: true,
    message: `Render started for ${appId} (${composition})`,
    composition,
    logPath,
  });
}
