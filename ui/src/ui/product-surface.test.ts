import { describe, expect, it, beforeEach } from "vitest";
import {
  applyControlUiProductCopy,
  formatControlUiCliCommand,
  setControlUiProductContext,
} from "./product-surface.ts";

describe("control-ui product-surface", () => {
  beforeEach(() => {
    setControlUiProductContext({
      productId: "openclaw",
      productDisplayName: "OpenClaw",
      defaultGatewayPort: 18_789,
    });
  });

  it("leaves strings unchanged outside ClaWorks mode", () => {
    expect(applyControlUiProductCopy("Run openclaw status")).toBe("Run openclaw status");
  });

  it("rewrites commands and ports in ClaWorks mode", () => {
    setControlUiProductContext({
      productId: "claworks",
      productDisplayName: "ClaWorks",
      defaultGatewayPort: 18_800,
    });
    expect(formatControlUiCliCommand("openclaw devices list")).toBe("claworks devices list");
    expect(applyControlUiProductCopy("Restart the Gateway after updating OpenClaw")).toBe(
      "Restart the Gateway after updating ClaWorks",
    );
    expect(applyControlUiProductCopy("Use http://127.0.0.1:18789 on the Gateway host.")).toContain(
      "18800",
    );
  });
});
