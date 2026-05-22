import type { ControlUiProductId } from "../../../src/gateway/control-ui-contract.js";

export const CLAWORKS_DEFAULT_GATEWAY_PORT = 18_800;
export const OPENCLAW_DEFAULT_GATEWAY_PORT = 18_789;

export type ControlUiProductContext = {
  productId: ControlUiProductId;
  productDisplayName: string;
  defaultGatewayPort: number;
};

let productContext: ControlUiProductContext = {
  productId: "openclaw",
  productDisplayName: "OpenClaw",
  defaultGatewayPort: OPENCLAW_DEFAULT_GATEWAY_PORT,
};

export function setControlUiProductContext(next: Partial<ControlUiProductContext>): void {
  productContext = {
    ...productContext,
    ...next,
  };
}

export function getControlUiProductContext(): ControlUiProductContext {
  return productContext;
}

export function isClaworksControlUi(): boolean {
  return productContext.productId === "claworks";
}

export function resolveControlUiDisplayName(): string {
  return productContext.productDisplayName;
}

export function formatControlUiCliCommand(command: string): string {
  if (!isClaworksControlUi()) {
    return command;
  }
  return command.replace(/\bopenclaw\b/g, "claworks");
}

/** Rewrite user-visible Control UI strings for ClaWorks product mode. */
export function applyControlUiProductCopy(value: string): string {
  if (!isClaworksControlUi()) {
    return value;
  }
  const product = productContext.productDisplayName;
  const port = String(productContext.defaultGatewayPort);
  return value
    .replaceAll("OpenClaw Control UI", "ClaWorks Control UI")
    .replaceAll("OpenClaw Control", "ClaWorks Control")
    .replaceAll("openclaw tui", "claworks tui")
    .replaceAll("ws://127.0.0.1:18789", `ws://127.0.0.1:${port}`)
    .replaceAll("http://127.0.0.1:18789", `http://127.0.0.1:${port}`)
    .replaceAll("http://localhost:18789", `http://localhost:${port}`)
    .replaceAll("openclaw.json", "claworks.json")
    .replaceAll("~/.openclaw", "~/.claworks")
    .replace(/\bopenclaw\b/g, "claworks")
    .replace(/\bOpenClaw\b/g, product);
}
