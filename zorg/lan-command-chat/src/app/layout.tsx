import type { Metadata } from "next";
import { readFile } from "node:fs/promises";

import { getIdentityPath } from "@/lib/paths";
import "./globals.css";

function extractName(markdown: string): string | null {
  const match = markdown.match(/^\s*-\s*\*\*Name:\*\*\s*(.+?)\s*$/im);
  const value = match?.[1]?.trim();
  return value || null;
}

async function loadAgentName() {
  try {
    const raw = await readFile(getIdentityPath(), "utf8");
    return extractName(raw) ?? "Assistant";
  } catch {
    return "Assistant";
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const agentName = await loadAgentName();
  return {
    title: agentName,
    description: "Dynamic LAN command chat on port 3001",
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
