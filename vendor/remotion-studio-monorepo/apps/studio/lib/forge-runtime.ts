import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

export type DevServerEntry = {
  appId: string;
  pid: number;
  port: number;
  startedAt: string;
  logPath: string;
};

type DevServerRegistry = Record<string, DevServerEntry>;

const runtimeDir = path.join(tmpdir(), "remotion-forge-runtime");
const registryPath = path.join(runtimeDir, "dev-servers.json");

function toEntry(appId: string, input: unknown): DevServerEntry | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const pid = typeof raw.pid === "number" ? raw.pid : Number(raw.pid);
  const port = typeof raw.port === "number" ? raw.port : Number(raw.port);

  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  return {
    appId,
    pid,
    port,
    startedAt:
      typeof raw.startedAt === "string" && raw.startedAt.trim().length > 0
        ? raw.startedAt
        : new Date(0).toISOString(),
    logPath:
      typeof raw.logPath === "string" && raw.logPath.trim().length > 0
        ? raw.logPath
        : "",
  };
}

async function ensureRuntimeDir(): Promise<void> {
  await fs.mkdir(runtimeDir, { recursive: true });
}

async function readRegistry(): Promise<DevServerRegistry> {
  await ensureRuntimeDir();
  const text = await fs.readFile(registryPath, "utf8").catch(() => null);
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const registry: DevServerRegistry = {};
    for (const [appId, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      const entry = toEntry(appId, value);
      if (entry) {
        registry[appId] = entry;
      }
    }
    return registry;
  } catch {
    return {};
  }
}

async function writeRegistry(registry: DevServerRegistry): Promise<void> {
  await ensureRuntimeDir();
  await fs.writeFile(
    registryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf8",
  );
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getActiveDevServer(
  appId: string,
): Promise<DevServerEntry | null> {
  const registry = await readRegistry();
  const entry = registry[appId];
  if (!entry) {
    return null;
  }

  if (isProcessAlive(entry.pid)) {
    return entry;
  }

  delete registry[appId];
  await writeRegistry(registry);
  return null;
}

export async function listActiveDevServers(): Promise<DevServerEntry[]> {
  const registry = await readRegistry();
  let dirty = false;
  const active: DevServerEntry[] = [];

  for (const [appId, entry] of Object.entries(registry)) {
    if (!isProcessAlive(entry.pid)) {
      delete registry[appId];
      dirty = true;
      continue;
    }
    active.push(entry);
  }

  if (dirty) {
    await writeRegistry(registry);
  }

  return active.sort((a, b) => a.appId.localeCompare(b.appId));
}

export async function upsertDevServer(entry: DevServerEntry): Promise<void> {
  const registry = await readRegistry();
  registry[entry.appId] = entry;
  await writeRegistry(registry);
}

export async function removeDevServer(
  appId: string,
): Promise<DevServerEntry | null> {
  const registry = await readRegistry();
  const entry = registry[appId] ?? null;
  if (!entry) {
    return null;
  }

  delete registry[appId];
  await writeRegistry(registry);
  return entry;
}
