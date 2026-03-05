import { existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { moveRenderFileToTrash } from "@/lib/forge-trash";
import { resolveAppsRoot } from "@/lib/project-meta";
import {
  collectRenderAssets,
  isRenderableVideoRelativePath,
} from "@/lib/render-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".gif": "image/gif",
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

function buildRenderUrl(appId: string, relativePath: string): string {
  return `/api/renders?app=${encodeURIComponent(appId)}&file=${encodeURIComponent(relativePath)}`;
}

function parseSingleByteRange(
  rangeHeader: string,
  fileSize: number,
): { start: number; end: number } | null {
  if (!rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const ranges = rangeHeader.slice(6).split(",");
  if (ranges.length !== 1) {
    return null;
  }

  const [rawStart = "", rawEnd = ""] = ranges[0].trim().split("-", 2);
  if (rawStart === "" && rawEnd === "") {
    return null;
  }

  if (rawStart === "") {
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    if (suffixLength >= fileSize) {
      return { start: 0, end: fileSize - 1 };
    }
    return { start: fileSize - suffixLength, end: fileSize - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start < 0 || start >= fileSize) {
    return null;
  }

  let end: number;
  if (rawEnd === "") {
    end = fileSize - 1;
  } else {
    end = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(end) || end < start) {
      return null;
    }
    if (end >= fileSize) {
      end = fileSize - 1;
    }
  }

  return { start, end };
}

function buildBaseHeaders(renderPath: string): HeadersInit {
  const ext = path.extname(renderPath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";

  return {
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename="${path.basename(renderPath)}"`,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
}

function invalidRangeResponse(fileSize: number): NextResponse {
  return new NextResponse(null, {
    status: 416,
    headers: {
      "Content-Range": `bytes */${fileSize}`,
      "Cache-Control": "no-store",
    },
  });
}

async function fileResponse(
  request: NextRequest,
  renderPath: string,
  fileSize: number,
): Promise<NextResponse> {
  const fileBuffer = await fs.readFile(renderPath).catch(() => null);
  if (!fileBuffer) {
    return NextResponse.json(
      { message: "Could not read render file." },
      { status: 500 },
    );
  }

  const headers = buildBaseHeaders(renderPath);
  const rangeHeader = request.headers.get("range");

  if (rangeHeader) {
    const parsedRange = parseSingleByteRange(rangeHeader, fileSize);
    if (!parsedRange) {
      return invalidRangeResponse(fileSize);
    }

    const { start, end } = parsedRange;
    const chunkSize = end - start + 1;
    const chunk = fileBuffer.subarray(start, end + 1);

    return new NextResponse(chunk, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      },
    });
  }

  return new NextResponse(fileBuffer, {
    status: 200,
    headers: {
      ...headers,
      "Content-Length": String(fileSize),
    },
  });
}

function headFileResponse(
  request: NextRequest,
  renderPath: string,
  fileSize: number,
): NextResponse {
  const headers = buildBaseHeaders(renderPath);
  const rangeHeader = request.headers.get("range");

  if (rangeHeader) {
    const parsedRange = parseSingleByteRange(rangeHeader, fileSize);
    if (!parsedRange) {
      return invalidRangeResponse(fileSize);
    }

    const { start, end } = parsedRange;
    const chunkSize = end - start + 1;
    return new NextResponse(null, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      },
    });
  }

  return new NextResponse(null, {
    status: 200,
    headers: {
      ...headers,
      "Content-Length": String(fileSize),
    },
  });
}

function resolveRenderPath(
  appDir: string,
  file: string | null,
):
  | { ok: true; path: string; size: number; relativePath: string }
  | { ok: false; response: NextResponse } {
  if (!file) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Invalid file path." },
        { status: 400 },
      ),
    };
  }

  if (hasTraversalPattern(file) || !isRenderableVideoRelativePath(file)) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Invalid file path." },
        { status: 400 },
      ),
    };
  }

  const renderPath = path.resolve(appDir, file);
  if (!isWithinPath(renderPath, appDir)) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Invalid file path." },
        { status: 400 },
      ),
    };
  }

  if (!existsSync(renderPath) || !statSync(renderPath).isFile()) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Render file not found." },
        { status: 404 },
      ),
    };
  }

  const size = statSync(renderPath).size;
  return { ok: true, path: renderPath, size, relativePath: file };
}

function resolveAppDirectory(
  appId: string | null,
):
  | { ok: true; appId: string; appDir: string; appsRoot: string }
  | { ok: false; response: NextResponse } {
  if (!appId || hasTraversalPattern(appId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Invalid app parameter." },
        { status: 400 },
      ),
    };
  }

  const appsRoot = resolveAppsRoot();
  const appDir = path.resolve(appsRoot, appId);
  if (!isWithinPath(appDir, appsRoot)) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Invalid app path." },
        { status: 400 },
      ),
    };
  }

  if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "App not found." },
        { status: 404 },
      ),
    };
  }

  return { ok: true, appId, appDir, appsRoot };
}

export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("app");
  const file = request.nextUrl.searchParams.get("file");

  const resolvedApp = resolveAppDirectory(appId);
  if (!resolvedApp.ok) {
    return resolvedApp.response;
  }

  if (file) {
    const resolved = resolveRenderPath(resolvedApp.appDir, file);
    if (!resolved.ok) {
      return resolved.response;
    }

    return fileResponse(request, resolved.path, resolved.size);
  }

  const files = await collectRenderAssets(resolvedApp.appDir, 200);
  return NextResponse.json({
    ok: true,
    appId: resolvedApp.appId,
    files: files.map((item) => ({
      relativePath: item.relativePath,
      fileName: item.fileName,
      size: item.size,
      updatedAt: new Date(item.mtimeMs).toISOString(),
      url: buildRenderUrl(resolvedApp.appId, item.relativePath),
    })),
  });
}

export async function HEAD(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("app");
  const file = request.nextUrl.searchParams.get("file");

  const resolvedApp = resolveAppDirectory(appId);
  if (!resolvedApp.ok) {
    return resolvedApp.response;
  }

  const resolved = resolveRenderPath(resolvedApp.appDir, file);
  if (!resolved.ok) {
    return resolved.response;
  }

  return headFileResponse(request, resolved.path, resolved.size);
}

export async function DELETE(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("app");
  const file = request.nextUrl.searchParams.get("file");

  const resolvedApp = resolveAppDirectory(appId);
  if (!resolvedApp.ok) {
    return resolvedApp.response;
  }

  const resolved = resolveRenderPath(resolvedApp.appDir, file);
  if (!resolved.ok) {
    return resolved.response;
  }

  const moved = await moveRenderFileToTrash({
    appsRoot: resolvedApp.appsRoot,
    appId: resolvedApp.appId,
    relativeFilePath: resolved.relativePath,
    absoluteFilePath: resolved.path,
  })
    .then(() => true)
    .catch(() => false);

  if (!moved) {
    return NextResponse.json(
      { message: "Could not move render file to trash." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    appId: resolvedApp.appId,
    file: resolved.relativePath,
    message: "Render file moved to trash.",
  });
}
