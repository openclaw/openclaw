import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeMode, ThemeName } from "../theme.ts";
import { type ConfigProps, renderConfig } from "./config.ts";

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
		container
			.querySelector<HTMLButtonElement>(".config-raw-toggle.active")
			?.click();
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

		const tabs = Array.from(
			container.querySelectorAll(".config-top-tabs__tab"),
		).map((tab) => tab.textContent?.trim());
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

		const clearButton = container.querySelector<HTMLButtonElement>(
			".config-search__clear",
		);
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
		expect(text).toContain(
			"Use the reveal button above to edit the raw config.",
		);
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

		const revealButton =
			container.querySelector<HTMLButtonElement>(".config-raw-toggle");
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
});
