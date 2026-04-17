import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeMode, ThemeName } from "../theme.ts";
import { renderConfig, type ConfigProps } from "./config.ts";

describe("config view", () => {
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
    version: "2026.3.11",
    theme: "claw" as ThemeName,
    themeMode: "system" as ThemeMode,
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    borderRadius: 50,
    setBorderRadius: vi.fn(),
    gatewayUrl: "",
    assistantName: "OpenClaw",
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

  function renderConfigView(overrides: Partial<ConfigProps> = {}): {
    container: HTMLElement;
    props: ConfigProps;
  } {
    const container = document.createElement("div");
    const props = {
      ...baseProps(),
      ...overrides,
    };
    const rerender = () =>
      render(
        renderConfig({
          ...props,
          onRequestUpdate: rerender,
        }),
        container,
      );
    rerender();
    return { container, props };
  }

  function normalizedText(container: HTMLElement): string {
    return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  function resetRawRevealState() {
    const { container } = renderConfigView({
      formMode: "raw",
      raw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      originalRaw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      formValue: {
        openai: {
          apiKey: "supersecret",
        },
      },
    });
    container.querySelector<HTMLButtonElement>(".config-raw-toggle.active")?.click();
  }

  beforeEach(() => {
    resetRawRevealState();
  });

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

  it("forces Form mode and disables Raw mode when raw text is unavailable", () => {
    const onFormModeChange = vi.fn();
    const { container } = renderConfigView({
      formMode: "raw",
      rawAvailable: false,
      onFormModeChange,
      schema: {
        type: "object",
        properties: {
          gateway: {
            type: "object",
            properties: {
              mode: { type: "string" },
            },
          },
        },
      },
      formValue: { gateway: { mode: "local" } },
      originalValue: { gateway: { mode: "local" } },
    });

    const formButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Form",
    );
    const rawButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Raw",
    );
    expect(formButton?.classList.contains("active")).toBe(true);
    expect(rawButton?.disabled).toBe(true);
    expect(normalizedText(container)).toContain(
      "Raw mode disabled (snapshot cannot safely round-trip raw text).",
    );
    expect(container.querySelector(".config-raw-field")).toBeNull();

    rawButton?.click();
    expect(onFormModeChange).not.toHaveBeenCalled();
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

  it("resets config content scroll when switching top-tab sections", async () => {
    const { container } = renderConfigView({
      activeSection: "channels",
      navRootLabel: "Communication",
      includeSections: ["channels", "messages"],
      schema: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              telegram: { type: "string" },
            },
          },
          messages: {
            type: "object",
            properties: {
              inbox: { type: "string" },
            },
          },
        },
      },
      formValue: {
        channels: { telegram: "on" },
        messages: { inbox: "smart" },
      },
      originalValue: {
        channels: { telegram: "on" },
        messages: { inbox: "smart" },
      },
    });

    const content = container.querySelector<HTMLElement>(".config-content");
    expect(content).toBeTruthy();
    if (!content) {
      return;
    }
    content.scrollTop = 280;
    content.scrollLeft = 24;
    content.scrollTo = vi.fn(({ top, left }: { top?: number; left?: number }) => {
      content.scrollTop = top ?? content.scrollTop;
      content.scrollLeft = left ?? content.scrollLeft;
    }) as typeof content.scrollTo;

    const messagesButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Messages",
    );
    expect(messagesButton).toBeTruthy();

    messagesButton?.click();
    await Promise.resolve();

    expect(content.scrollTo).toHaveBeenCalledOnce();
    expect(content.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
    expect(content.scrollTop).toBe(0);
    expect(content.scrollLeft).toBe(0);
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

  it("renders the top search icon inside the search input row", () => {
    const container = document.createElement("div");
    render(renderConfig(baseProps()), container);

    const icon = container.querySelector<SVGElement>(".config-search__icon");
    expect(icon).not.toBeNull();
    expect(icon?.closest(".config-search__input-row")).not.toBeNull();
  });

  it("renders top tabs for root and available sections", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
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

    const tabs = Array.from(container.querySelectorAll(".config-top-tabs__tab")).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabs).toContain("Settings");
    expect(tabs).toContain("Agents");
    expect(tabs).toContain("Gateway");
  });

  it("clears the active search query", () => {
    const container = document.createElement("div");
    const onSearchChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        searchQuery: "gateway",
        onSearchChange,
      }),
      container,
    );

    const clearButton = container.querySelector<HTMLButtonElement>(".config-search__clear");
    expect(clearButton).toBeTruthy();
    clearButton?.click();
    expect(onSearchChange).toHaveBeenCalledWith("");
  });

  it("keeps sensitive raw config hidden until reveal", () => {
    const { container } = renderConfigView({
      formMode: "raw",
      raw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      originalRaw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      formValue: {
        openai: {
          apiKey: "supersecret",
        },
      },
    });

    const text = normalizedText(container);
    expect(text).toContain("1 secret redacted");
    expect(text).toContain("Use the reveal button above to edit the raw config.");
    expect(text).not.toContain("supersecret");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("reveals sensitive raw config before editing", () => {
    const onRawChange = vi.fn();
    const { container } = renderConfigView({
      formMode: "raw",
      raw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      originalRaw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      formValue: {
        openai: {
          apiKey: "supersecret",
        },
      },
      onRawChange,
    });

    const revealButton = container.querySelector<HTMLButtonElement>(".config-raw-toggle");
    expect(revealButton).toBeTruthy();
    revealButton?.click();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toContain("supersecret");
    if (!textarea) {
      return;
    }
    textarea.value = textarea.value.replace("supersecret", "updatedsecret");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onRawChange).toHaveBeenCalledWith(textarea.value);
  });

  it("renders structured SecretRef values as read-only text inputs without stringifying", () => {
    const onFormPatch = vi.fn();
    const { container } = renderConfigView({
      schema: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              discord: {
                type: "object",
                properties: {
                  token: { type: "string" },
                },
              },
            },
          },
        },
      },
      uiHints: {
        "channels.discord.token": { sensitive: true },
      },
      formMode: "form",
      formValue: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" },
          },
        },
      },
      originalValue: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          },
        },
      },
      onFormPatch,
    });

    const input = container.querySelector<HTMLInputElement>(".cfg-input");
    expect(input).not.toBeNull();
    expect(input?.readOnly).toBe(true);
    expect(input?.value).toBe("");
    expect(input?.placeholder).toContain("Structured value (SecretRef)");
    expect(container.textContent ?? "").not.toContain("[object Object]");

    if (!input) {
      return;
    }
    input.value = "[object Object]";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onFormPatch).not.toHaveBeenCalled();
  });

  it("uses a file-edit placeholder for structured SecretRefs when raw mode is unavailable", () => {
    const { container } = renderConfigView({
      rawAvailable: false,
      formMode: "raw",
      schema: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              discord: {
                type: "object",
                properties: {
                  token: { type: "string" },
                },
              },
            },
          },
        },
      },
      uiHints: {
        "channels.discord.token": { sensitive: true },
      },
      formValue: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" },
          },
        },
      },
      originalValue: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          },
        },
      },
    });

    const input = container.querySelector<HTMLInputElement>(".cfg-input");
    expect(input).not.toBeNull();
    expect(input?.placeholder).toBe("Structured value (SecretRef) - edit the config file directly");
  });

  it("keeps malformed non-SecretRef object values editable when raw mode is unavailable", () => {
    const onFormPatch = vi.fn();
    const { container } = renderConfigView({
      rawAvailable: false,
      formMode: "raw",
      schema: {
        type: "object",
        properties: {
          gateway: {
            type: "object",
            properties: {
              mode: { type: "string" },
            },
          },
        },
      },
      formValue: {
        gateway: {
          mode: { malformed: true },
        },
      },
      originalValue: {
        gateway: {
          mode: { malformed: true },
        },
      },
      onFormPatch,
    });

    const input = container.querySelector<HTMLInputElement>(".cfg-input");
    expect(input).not.toBeNull();
    expect(input?.readOnly).toBe(false);
    expect(input?.value).toContain("malformed");
    expect(input?.value).not.toBe("[object Object]");
    expect(input?.placeholder).not.toContain("Structured value (SecretRef)");

    if (!input) {
      return;
    }
    input.value = "local";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onFormPatch).toHaveBeenCalledWith(["gateway", "mode"], "local");
  });
});
