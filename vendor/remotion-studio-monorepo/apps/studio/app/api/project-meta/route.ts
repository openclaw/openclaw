import { existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { resolveAppsRoot } from "@/lib/project-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AppMeta = {
  title: string;
  description: string;
  tags: string[];
  thumbnail: string;
  lastRendered: string | null;
  category: string;
};

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

function toTags(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.filter((item): item is string => typeof item === "string");
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }
  return [];
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    appId?: string;
    meta?: {
      title?: string;
      description?: string;
      tags?: string[] | string;
      thumbnail?: string;
      category?: string;
    };
  } | null;

  if (!body?.appId || typeof body.appId !== "string" || !body.meta) {
    return NextResponse.json(
      { message: "appId and meta are required." },
      { status: 400 },
    );
  }

  if (hasTraversalPattern(body.appId)) {
    return NextResponse.json({ message: "Invalid appId." }, { status: 400 });
  }

  const appsRoot = resolveAppsRoot();
  const appDir = path.resolve(appsRoot, body.appId);
  if (!isWithinPath(appDir, appsRoot)) {
    return NextResponse.json({ message: "Invalid app path." }, { status: 400 });
  }
  if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
    return NextResponse.json({ message: "App not found." }, { status: 404 });
  }

  const title = (body.meta.title ?? "").trim();
  const description = (body.meta.description ?? "").trim();
  const category = (body.meta.category ?? "").trim();
  const thumbnail = (body.meta.thumbnail ?? "").trim();
  const tags = toTags(body.meta.tags);

  if (!title || !description || !category || !thumbnail || tags.length === 0) {
    return NextResponse.json(
      {
        message:
          "title, description, category, thumbnail and at least one tag are required.",
      },
      { status: 400 },
    );
  }

  const metaPath = path.join(appDir, "app.meta.json");
  let lastRendered: string | null = null;

  if (existsSync(metaPath)) {
    const existing = await fs.readFile(metaPath, "utf8").catch(() => null);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as { lastRendered?: unknown };
        if (typeof parsed.lastRendered === "string") {
          lastRendered = parsed.lastRendered;
        }
      } catch {
        lastRendered = null;
      }
    }
  }

  const nextMeta: AppMeta = {
    title,
    description,
    tags,
    thumbnail,
    lastRendered,
    category,
  };

  await fs.writeFile(
    metaPath,
    `${JSON.stringify(nextMeta, null, 2)}\n`,
    "utf8",
  );

  return NextResponse.json({ ok: true, meta: nextMeta });
}
