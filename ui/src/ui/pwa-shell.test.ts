import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(pathFromRoot: string): string {
  const filePath = [
    resolve(process.cwd(), pathFromRoot),
    resolve(process.cwd(), "..", pathFromRoot),
  ].find((candidate) => existsSync(candidate));
  expect(filePath).toBeTruthy();
  return readFileSync(filePath!, "utf8");
}

describe("mobile PWA shell", () => {
  it("includes iOS home-screen metadata and safe viewport settings", () => {
    const indexHtml = readRepoFile("ui/index.html");

    expect(indexHtml).toContain('name="viewport"');
    expect(indexHtml).toContain(
      "width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content",
    );
    expect(indexHtml).toContain('<meta name="mobile-web-app-capable" content="yes" />');
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="OpenClaw" />');
    expect(indexHtml).toContain(
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    );
    expect(indexHtml).toContain('<link rel="apple-touch-icon" sizes="180x180"');
    expect(indexHtml).toContain('<link rel="manifest" href="manifest.webmanifest" />');
    expect(indexHtml).toContain("OpenClaw Dashboard");
    expect(indexHtml).toContain("Cached app shell ready");
    expect(indexHtml).toContain('[data-openclaw-control-ui-ready="1"] .boot-shell');
    expect(indexHtml).toContain("Reset cached dashboard");
    expect(indexHtml).toContain("__openclaw_mobile_rescue");
    expect(indexHtml).toContain("openclaw-control-ui-ready");
    expect(indexHtml).toContain("window.caches.delete");
    expect(indexHtml).toContain("registration.unregister");
    expect(indexHtml).toContain("openclaw-boot-pulse");
    expect(indexHtml).toContain("prefers-reduced-motion: reduce");
  });

  it("removes the boot shell once the application module loads", () => {
    const mainTs = readRepoFile("ui/src/main.ts");

    expect(mainTs).toContain("function removeBootShell()");
    expect(mainTs).toContain('document.querySelector("openclaw-app")');
    expect(mainTs).toContain('querySelector(".boot-shell")?.remove()');
    expect(mainTs).toContain('new CustomEvent("openclaw-control-ui-ready")');
    expect(mainTs).toContain('data-openclaw-control-ui-ready", "1"');
  });

  it("keeps navigation network-first while retaining an offline cached shell", () => {
    const serviceWorker = readRepoFile("ui/public/sw.js");

    expect(serviceWorker).toContain('CACHE_NAME = "openclaw-control-v18"');
    expect(serviceWorker).toContain("APP_SHELL_URLS");
    expect(serviceWorker).toContain('ASSET_MANIFEST_URL = "./asset-manifest.json"');
    expect(serviceWorker).toContain('MOBILE_RESCUE_QUERY = "__openclaw_mobile_rescue"');
    expect(serviceWorker).toContain("CRITICAL_ASSET_PATTERNS");
    expect(serviceWorker).toContain("cacheAssetManifest");
    expect(serviceWorker).toContain("void cacheAssetManifest(cache, { criticalOnly: true })");
    expect(serviceWorker).toContain("collectManifestAssetUrls");
    expect(serviceWorker).toContain("warmAppAssets");
    expect(serviceWorker).toContain("refreshNavigationShell");
    expect(serviceWorker).toContain("cacheNavigationResponse");
    expect(serviceWorker).toContain("navigationPreload");
    expect(serviceWorker).toContain("cachedShell");
    expect(serviceWorker).toContain('fetch(event.request, { cache: "no-store" })');
    expect(serviceWorker).toContain(
      "event.waitUntil(Promise.all([refreshNavigationShell(event.request), warmAppAssets()]))",
    );
    expect(serviceWorker).toContain('SERVICE_WORKER_UPDATE_QUERY = "__openclaw_sw_update"');
    expect(serviceWorker).toContain("url.searchParams.has(SERVICE_WORKER_UPDATE_QUERY)");
    expect(serviceWorker).toContain("url.searchParams.has(MOBILE_RESCUE_QUERY)");
    expect(serviceWorker).toContain('url.pathname.startsWith("/__openclaw/")');
  });

  it("emits a production asset manifest for service-worker cache warming", () => {
    const viteConfig = readRepoFile("ui/vite.config.ts");

    expect(viteConfig).toContain('manifest: "asset-manifest.json"');
  });

  it("keeps the manifest installable without leaving the gateway origin", () => {
    const manifest = JSON.parse(readRepoFile("ui/public/manifest.webmanifest")) as {
      id?: string;
      start_url?: string;
      scope?: string;
      display?: string;
      display_override?: string[];
      orientation?: string;
      icons?: Array<{ src?: string; sizes?: string; type?: string }>;
    };

    expect(manifest.id).toBe("./");
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(manifest.display).toBe("standalone");
    expect(manifest.display_override).toContain("standalone");
    expect(manifest.orientation).toBe("any");
    expect(manifest.icons?.some((icon) => icon.src === "./apple-touch-icon.png")).toBe(true);
  });

  it("keeps standalone mode constrained to the visible device safe area", () => {
    const baseCss = readRepoFile("ui/src/styles/base.css");

    expect(baseCss).toContain("@media (display-mode: standalone)");
    expect(baseCss).toContain("height: 100dvh;");
    expect(baseCss).toContain("padding-top: var(--safe-area-top);");
    expect(baseCss).toContain("padding-bottom: var(--safe-area-bottom);");
    expect(baseCss).toContain("overscroll-behavior: none;");
  });

  it("uses an app-like connection loader with reduced-motion support", () => {
    const componentsCss = readRepoFile("ui/src/styles/components.css");

    expect(componentsCss).toContain(".connection-loader");
    expect(componentsCss).toContain(".connection-loader__logo-wrap");
    expect(componentsCss).toContain(".connection-loader__telemetry");
    expect(componentsCss).toContain("openclaw-loader-orbit");
    expect(componentsCss).toContain("openclaw-logo-throb");
    expect(componentsCss).toContain("env(safe-area-inset-top");
    expect(componentsCss).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
