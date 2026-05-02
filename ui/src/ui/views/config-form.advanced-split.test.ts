import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { renderConfigForm, type ConfigFormProps } from "./config-form.render.ts";

const sectionSchema = {
  type: "object" as const,
  properties: {
    auth: {
      type: "object" as const,
      properties: {
        profiles: { type: "string" as const },
        cooldowns: { type: "string" as const },
      },
    },
  },
};

const hints = {
  "auth.cooldowns": { advanced: true, tags: ["advanced"] },
};

function makeProps(overrides: Partial<ConfigFormProps> = {}): ConfigFormProps {
  return {
    schema: sectionSchema,
    uiHints: hints,
    value: { auth: { profiles: "default", cooldowns: "60" } },
    rawAvailable: false,
    disabled: false,
    unsupportedPaths: [],
    searchQuery: "",
    activeSection: "auth",
    activeSubsection: null,
    revealSensitive: false,
    onPatch: () => {},
    ...overrides,
  };
}

describe("config form advanced split", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
  });

  it("renders advanced fields inside a collapsed disclosure when search is inactive", () => {
    render(renderConfigForm(makeProps()), container);
    expect(container.querySelector(".cfg-advanced-section")).not.toBeNull();
  });

  it("bypasses the disclosure when free-text search is active", () => {
    render(renderConfigForm(makeProps({ searchQuery: "cooldowns" })), container);
    expect(container.querySelector(".cfg-advanced-section")).toBeNull();
  });

  it("bypasses the disclosure when a tag search is active", () => {
    render(renderConfigForm(makeProps({ searchQuery: "tag:advanced" })), container);
    expect(container.querySelector(".cfg-advanced-section")).toBeNull();
  });

  it("bypasses the disclosure when the section self-matches the search query", () => {
    // "auth" matches the section label — childSearchCriteria is cleared by self-match,
    // but the original criteria is still active so the split must be bypassed.
    render(renderConfigForm(makeProps({ searchQuery: "auth" })), container);
    expect(container.querySelector(".cfg-advanced-section")).toBeNull();
  });
});
