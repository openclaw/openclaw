import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

import { renderConfig } from "./config";

describe("config view", () => {
  const baseProps = () => ({
    raw: "{\n}\n",
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
    formValue: {},
    originalValue: {},
    searchQuery: "",
    activeSection: null,
    activeSubsection: null,
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
  });

  it("disables save when form is unsafe", () => {
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

    const saveButton = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.trim() === "Save") as
      | HTMLButtonElement
      | undefined;
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(true);
  });

  it("applies MiniMax preset via onRawChange + onFormPatch", () => {
    const container = document.createElement("div");
    const onRawChange = vi.fn();
    const onFormPatch = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onRawChange,
        onFormPatch,
      }),
      container,
    );

    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("MiniMax M2.1"),
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    btn?.click();

    expect(onRawChange).toHaveBeenCalled();
    const raw = String(onRawChange.mock.calls.at(-1)?.[0] ?? "");
    expect(raw).toContain("https://api.minimax.io/anthropic");
    expect(raw).toContain("anthropic-messages");
    expect(raw).toContain("minimax/MiniMax-M2.1");
    expect(raw).toContain("MINIMAX_API_KEY");

    expect(onFormPatch).toHaveBeenCalledWith(
      ["agents", "defaults", "model", "primary"],
      "minimax/MiniMax-M2.1",
    );
  });

  it("does not clobber existing MiniMax apiKey when applying preset", () => {
    const container = document.createElement("div");
    const onRawChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onRawChange,
        formValue: {
          models: {
            mode: "merge",
            providers: {
              minimax: {
                apiKey: "EXISTING_KEY",
              },
            },
          },
        },
      }),
      container,
    );

    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("MiniMax M2.1"),
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    btn?.click();

    const raw = String(onRawChange.mock.calls.at(-1)?.[0] ?? "");
    expect(raw).toContain("EXISTING_KEY");
  });

  it("applies Z.AI (GLM 4.7) preset", () => {
    const container = document.createElement("div");
    const onRawChange = vi.fn();
    const onFormPatch = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onRawChange,
        onFormPatch,
      }),
      container,
    );

    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("GLM 4.7"),
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    btn?.click();

    const raw = String(onRawChange.mock.calls.at(-1)?.[0] ?? "");
    expect(raw).toContain("zai/glm-4.7");
    expect(raw).toContain("ZAI_API_KEY");
    expect(onFormPatch).toHaveBeenCalledWith(
      ["agents", "defaults", "model", "primary"],
      "zai/glm-4.7",
    );
  });

  it("applies Moonshot (Kimi) preset", () => {
    const container = document.createElement("div");
    const onRawChange = vi.fn();
    const onFormPatch = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onRawChange,
        onFormPatch,
      }),
      container,
    );

    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Kimi"),
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    btn?.click();

    const raw = String(onRawChange.mock.calls.at(-1)?.[0] ?? "");
    expect(raw).toContain("https://api.moonshot.ai/v1");
    expect(raw).toContain("moonshot/kimi-k2-0905-preview");
    expect(raw).toContain("moonshot/kimi-k2-turbo-preview");
    expect(raw).toContain("moonshot/kimi-k2-thinking");
    expect(raw).toContain("moonshot/kimi-k2-thinking-turbo");
    expect(raw).toContain("Kimi K2 Turbo");
    expect(raw).toContain("Kimi K2 Thinking");
    expect(raw).toContain("Kimi K2 Thinking Turbo");
    expect(raw).toContain("MOONSHOT_API_KEY");
    expect(onFormPatch).toHaveBeenCalledWith(
      ["agents", "defaults", "model", "primary"],
      "moonshot/kimi-k2-0905-preview",
    );
  });
});
