// Control UI tests cover external link behavior.
import { describe, expect, it } from "vitest";
import { SUPPORTED_LOCALES } from "../i18n/index.ts";
import { buildDocsHref, buildExternalLinkRel } from "./external-link.ts";

describe("buildDocsHref", () => {
  it("localizes dashboard docs for every non-English UI locale with generated docs", () => {
    const localizedLocales = SUPPORTED_LOCALES.filter((locale) => locale !== "en");

    for (const locale of localizedLocales) {
      expect(buildDocsHref("/web/dashboard", locale), locale).toBe(
        `https://docs.openclaw.ai/${locale}/web/dashboard`,
      );
    }
  });

  it("keeps English docs on the default URL", () => {
    expect(buildDocsHref("/web/dashboard", "en")).toBe("https://docs.openclaw.ai/web/dashboard");
  });

  it("falls back to the default URL for unknown locales", () => {
    expect(buildDocsHref("/web/dashboard", "en-GB")).toBe("https://docs.openclaw.ai/web/dashboard");
  });

  it("preserves absolute docs paths and anchors when localizing", () => {
    expect(
      buildDocsHref(
        "https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection",
        "zh-CN",
      ),
    ).toBe("https://docs.openclaw.ai/zh-CN/web/control-ui#device-pairing-first-connection");
  });
});

describe("buildExternalLinkRel", () => {
  it("always includes required security tokens", () => {
    expect(buildExternalLinkRel()).toBe("noopener noreferrer");
  });

  it("preserves extra rel tokens while deduping required ones", () => {
    expect(buildExternalLinkRel("noreferrer nofollow NOOPENER")).toBe(
      "noopener noreferrer nofollow",
    );
  });

  it("ignores whitespace-only rel input", () => {
    expect(buildExternalLinkRel("   ")).toBe("noopener noreferrer");
  });
});
