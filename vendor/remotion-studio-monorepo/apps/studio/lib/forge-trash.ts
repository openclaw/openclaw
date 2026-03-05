import { promises as fs } from "node:fs";
import path from "node:path";

const FORGE_TRASH_DIR_NAME = ".forge-trash";

function toTimestampToken(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isExDevError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EXDEV"
  );
}

function normalizeForPathSegment(value: string): string {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).join("/");
}

function resolveTrashRoot(appsRoot: string): string {
  return path.join(path.dirname(appsRoot), FORGE_TRASH_DIR_NAME);
}

async function movePath(sourcePath: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!isExDevError(error)) {
      throw error;
    }
  }

  const sourceStats = await fs.stat(sourcePath);
  if (sourceStats.isDirectory()) {
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    await fs.rm(sourcePath, { recursive: true, force: true });
    return;
  }

  await fs.copyFile(sourcePath, targetPath);
  await fs.unlink(sourcePath);
}

export async function moveProjectToTrash({
  appsRoot,
  appId,
  appDir,
}: {
  appsRoot: string;
  appId: string;
  appDir: string;
}): Promise<string> {
  const trashRoot = resolveTrashRoot(appsRoot);
  const safeAppIdPath = normalizeForPathSegment(appId);
  const timestamp = toTimestampToken();
  const targetPath = path.join(
    trashRoot,
    "projects",
    safeAppIdPath,
    `${path.basename(appDir)}-${timestamp}`,
  );

  await movePath(appDir, targetPath);
  return targetPath;
}

export async function moveRenderFileToTrash({
  appsRoot,
  appId,
  relativeFilePath,
  absoluteFilePath,
}: {
  appsRoot: string;
  appId: string;
  relativeFilePath: string;
  absoluteFilePath: string;
}): Promise<string> {
  const trashRoot = resolveTrashRoot(appsRoot);
  const safeAppIdPath = normalizeForPathSegment(appId);
  const safeRelativePath = normalizeForPathSegment(relativeFilePath);
  const timestamp = toTimestampToken();
  const targetPath = path.join(
    trashRoot,
    "renders",
    safeAppIdPath,
    timestamp,
    safeRelativePath,
  );

  await movePath(absoluteFilePath, targetPath);
  return targetPath;
}
