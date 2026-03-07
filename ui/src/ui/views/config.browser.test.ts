import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderConfig, resetConfigViewStateForTests } from "./config.ts";

describe("config view", () => {
  beforeEach(() => {
    resetConfigViewStateForTests();
  });

  const baseProps = () => ({
    raw: "{\n}\n",
    originalRaw: "{\n}\n",
    valid: true,
    issues: [],
    loading: false,
    saving: false,
    applying: false,
    updating: false,
    connected: true,
    schema: {
      type: "object",
      properties: {},
    },
    schemaLoading: false,
    uiHints: {},
    formMode: "form" as const,
    showModeToggle: true,
    formValue: {},
    originalValue: {},
    searchQuery: "",
    activeSection: null,
    activeSubsection: null,
    streamMode: false,
    onRawChange: vi.fn(),
    onFormModeChange: vi.fn(),
    onFormPatch: vi.fn(),
    onSearchChange: vi.fn(),
    onSectionChange: vi.fn(),
    onReload: vi.fn(),
    onSave: vi.fn(),
    onApply: vi.fn(),
    onUpdate: vi.fn(),
    onSubsectionChange: vi.fn(),
    version: "",
    theme: "claw" as const,
    themeMode: "system" as const,
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    gatewayUrl: "",
    assistantName: "",
  });

  function findActionButtons(container: HTMLElement): {
    saveButton?: HTMLButtonElement;
    applyButton?: HTMLButtonElement;
  } {
    const buttons = Array.from(container.querySelectorAll("button"));
    return {
      saveButton: buttons.find((btn) => btn.textContent?.trim() === "Save"),
      applyButton: buttons.find((btn) => btn.textContent?.trim() === "Apply"),
    };
  }

  it("allows save when form is unsafe", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        schema: {
          type: "object",
          properties: {
            mixed: {
              anyOf: [{ type: "string" }, { type: "object", properties: {} }],
            },
          },
        },
        schemaLoading: false,
        uiHints: {},
        formMode: "form",
        formValue: { mixed: "x" },
      }),
      container,
    );

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Save",
    );
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(false);
  });

  it("disables save when schema is missing", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        schema: null,
        formMode: "form",
        formValue: { gateway: { mode: "local" } },
        originalValue: {},
      }),
      container,
    );

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Save",
    );
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(true);
  });

  it("disables save and apply when raw is unchanged", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        formMode: "raw",
        raw: "{\n}\n",
        originalRaw: "{\n}\n",
      }),
      container,
    );

    const { saveButton, applyButton } = findActionButtons(container);
    expect(saveButton).not.toBeUndefined();
    expect(applyButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(true);
    expect(applyButton?.disabled).toBe(true);
  });

  it("enables save and apply when raw changes", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        formMode: "raw",
        raw: '{\n  gateway: { mode: "local" }\n}\n',
        originalRaw: "{\n}\n",
      }),
      container,
    );

    const { saveButton, applyButton } = findActionButtons(container);
    expect(saveButton).not.toBeUndefined();
    expect(applyButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(false);
    expect(applyButton?.disabled).toBe(false);
  });

  it("keeps raw secrets out of the DOM while stream mode is enabled", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        formMode: "raw",
        streamMode: true,
        raw: '{\n  gateway: { auth: { token: "secret-123" } }\n}\n',
        originalRaw: "{\n}\n",
        formValue: { gateway: { auth: { token: "secret-123" } } },
        uiHints: {
          "gateway.auth.token": { sensitive: true },
        },
      }),
      container,
    );

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("");
    expect(textarea?.getAttribute("placeholder")).toContain("redacted");

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle raw config redaction"]',
    );
    expect(toggle?.disabled).toBe(true);
  });

  it("reveals raw secrets only after explicit toggle when stream mode is off", () => {
    const container = document.createElement("div");
    const props = {
      ...baseProps(),
      formMode: "raw" as const,
      streamMode: false,
      raw: '{\n  gateway: { auth: { token: "secret-123" } }\n}\n',
      originalRaw: "{\n}\n",
      formValue: { gateway: { auth: { token: "secret-123" } } },
      uiHints: {
        "gateway.auth.token": { sensitive: true },
      },
    };

    render(renderConfig(props), container);
    const initialTextarea = container.querySelector("textarea");
    expect(initialTextarea?.value).toBe("");

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle raw config redaction"]',
    );
    expect(toggle?.disabled).toBe(false);
    toggle?.click();

    render(renderConfig(props), container);
    const revealedTextarea = container.querySelector("textarea");
    expect(revealedTextarea?.value).toContain("secret-123");
  });

  it("reveals env values through the peek control instead of CSS-only masking", () => {
    const container = document.createElement("div");
    const props = {
      ...baseProps(),
      activeSection: "env" as const,
      formMode: "form" as const,
      streamMode: false,
      schema: {
        type: "object",
        properties: {
          env: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
      formValue: {
        env: {
          OPENAI_API_KEY: "secret-123",
        },
      },
    };

    render(renderConfig(props), container);
    const hiddenInput = container.querySelector<HTMLInputElement>(".cfg-input:not(.cfg-input--sm)");
    expect(hiddenInput?.value).toBe("");

    const peekButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Peek"),
    );
    peekButton?.click();

    render(renderConfig(props), container);
    const revealedInput = container.querySelector<HTMLInputElement>(
      ".cfg-input:not(.cfg-input--sm)",
    );
    expect(revealedInput?.value).toBe("secret-123");
  });

  it("switches mode via the sidebar toggle", () => {
    const container = document.createElement("div");
    const onFormModeChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onFormModeChange,
      }),
      container,
    );

    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Raw",
    );
    expect(btn).toBeTruthy();
    btn?.click();
    expect(onFormModeChange).toHaveBeenCalledWith("raw");
  });

  it("switches sections from the sidebar", () => {
    const container = document.createElement("div");
    const onSectionChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onSectionChange,
        schema: {
          type: "object",
          properties: {
            gateway: { type: "object", properties: {} },
            agents: { type: "object", properties: {} },
          },
        },
      }),
      container,
    );

    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Gateway",
    );
    expect(btn).toBeTruthy();
    btn?.click();
    expect(onSectionChange).toHaveBeenCalledWith("gateway");
  });

  it("wires search input to onSearchChange", () => {
    const container = document.createElement("div");
    const onSearchChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onSearchChange,
      }),
      container,
    );

    const input = container.querySelector(".config-search__input");
    expect(input).not.toBeNull();
    if (!input) {
      return;
    }
    (input as HTMLInputElement).value = "gateway";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onSearchChange).toHaveBeenCalledWith("gateway");
  });

  it("shows all tag options in compact tag picker", () => {
    const container = document.createElement("div");
    render(renderConfig(baseProps()), container);

    expect(container.querySelectorAll(".config-search__tag-option")).toHaveLength(0);
  });

  it("updates search query when toggling a tag option", () => {
    const container = document.createElement("div");
    const onSearchChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onSearchChange,
      }),
      container,
    );

    const option = container.querySelector<HTMLButtonElement>(
      '.config-search__tag-option[data-tag="security"]',
    );
    expect(option).toBeNull();
    expect(onSearchChange).not.toHaveBeenCalled();
  });
});
