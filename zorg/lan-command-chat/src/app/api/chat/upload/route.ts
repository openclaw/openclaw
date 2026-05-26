import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getHostUploadDir } from "@/lib/paths";

export const runtime = "nodejs";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads");
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB per file

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const parts = form.getAll("files");

    if (!parts.length) {
      return NextResponse.json({ error: "No files uploaded" }, { status: 400 });
    }

    await mkdir(UPLOAD_DIR, { recursive: true });

    const uploaded: Array<{ name: string; type: string; size: number; url: string; path: string; containerPath: string }> = [];

    for (const part of parts) {
      if (!(part instanceof File)) continue;
      if (part.size <= 0) continue;
      if (part.size > MAX_FILE_BYTES) {
        return NextResponse.json({ error: `${part.name} exceeds 15MB limit` }, { status: 413 });
      }

      const ext = path.extname(part.name || "");
      const base = safeName(path.basename(part.name || "upload", ext)) || "upload";
      const filename = `${Date.now()}-${randomUUID()}-${base}${ext}`;
      const abs = path.join(UPLOAD_DIR, filename);
      const hostPath = path.join(getHostUploadDir(), filename);
      const bytes = Buffer.from(await part.arrayBuffer());
      await writeFile(abs, bytes);

      uploaded.push({
        name: part.name || filename,
        type: part.type || "application/octet-stream",
        size: part.size,
        url: `/uploads/${filename}`,
        path: hostPath,
        containerPath: abs,
      });
    }

    if (!uploaded.length) {
      return NextResponse.json({ error: "No valid files uploaded" }, { status: 400 });
    }

    return NextResponse.json({ files: uploaded });
  } catch (error) {
    console.error("chat.upload failed", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
