import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("sidebar connection status", () => {
  it("shows a single online status dot next to the version", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.hello = {
      ok: true,
      server: { version: "1.2.3" },
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    const version = app.querySelector<HTMLElement>(".sidebar-version");
    const statusDot = app.querySelector<HTMLElement>(".sidebar-version__status");
    expect(version).not.toBeNull();
    expect(statusDot).not.toBeNull();
    expect(statusDot?.getAttribute("aria-label")).toContain("Online");
  });
});
