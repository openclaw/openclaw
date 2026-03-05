import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export type RenderAsset = {
  relativePath: string;
  fileName: string;
  size: number;
  mtimeMs: number;
};

const RENDER_EXT_RE = /\.(mp4|mov|webm|gif)$/i;
const RENDER_DIRS = ["out", "public/assets/video"] as const;
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

function isVideoFilePath(value: string): boolean {
  return RENDER_EXT_RE.test(value);
}

async function collectVideoFilesRecursively(
  baseDir: string,
  currentDir: string,
  depth = 0,
  maxDepth = 6,
): Promise<RenderAsset[]> {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await fs
    .readdir(currentDir, { withFileTypes: true })
    .catch(() => []);

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        return collectVideoFilesRecursively(
          baseDir,
          fullPath,
          depth + 1,
          maxDepth,
        );
      }

      if (!entry.isFile() || !isVideoFilePath(entry.name)) {
        return [];
      }

      const stats = await fs.stat(fullPath).catch(() => null);
      if (!stats?.isFile()) {
        return [];
      }

      return [
        {
          relativePath: path
            .relative(baseDir, fullPath)
            .replaceAll(path.sep, "/"),
          fileName: entry.name,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        } satisfies RenderAsset,
      ];
    }),
  );

  return nested.flat();
}

export async function collectRenderAssets(
  appDir: string,
  limit = 100,
): Promise<RenderAsset[]> {
  const collected = await Promise.all(
    RENDER_DIRS.map(async (dir) => {
      const root = path.join(appDir, dir);
      if (!existsSync(root)) {
        return [];
      }
      return collectVideoFilesRecursively(appDir, root);
    }),
  );

  const deduped = new Map<string, RenderAsset>();
  for (const asset of collected.flat()) {
    const current = deduped.get(asset.relativePath);
    if (!current || current.mtimeMs < asset.mtimeMs) {
      deduped.set(asset.relativePath, asset);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, limit));
}

export function isRenderableVideoRelativePath(value: string): boolean {
  return isVideoFilePath(value);
}
