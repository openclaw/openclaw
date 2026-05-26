import path from "node:path";

function firstNonEmpty(...values: Array<string | undefined | null>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function getWorkspaceDir() {
  return firstNonEmpty(
    process.env.OPENCLAW_WORKSPACE,
    process.env.WORKSPACE_DIR,
    process.env.OPENCLAW_WORKSPACE_DIR,
  ) ?? path.join(process.env.HOME || process.cwd(), ".openclaw", "workspace");
}

export function getIdentityPath() {
  return path.join(getWorkspaceDir(), "IDENTITY.md");
}

export function getHostUploadDir() {
  return firstNonEmpty(process.env.HOST_UPLOAD_DIR) ?? path.join(getWorkspaceDir(), "lan-chat", "uploads");
}
