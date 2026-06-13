/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderAgentOverview } from "./agents-panels-overview.ts";

function renderOverview(configLoading: boolean) {
  const container = document.createElement("div");
  render(
    renderAgentOverview({
      agent: {
        id: "main",
        label: "Main",
        model: "openai/gpt-5",
        workspace: "default",
        agentRuntime: "native",
        thinkingDefault: "adaptive",
      } as never,
      basePath: "",
      defaultId: "main",
      configForm: {},
      agentFilesList: null,
      agentIdentity: null,
      agentIdentityLoading: false,
      agentIdentityError: null,
      configLoading,
      configSaving: false,
      configDirty: false,
      modelCatalog: [],
      onConfigReload: vi.fn(),
      onConfigSave: vi.fn(),
      onModelChange: vi.fn(),
      onModelFallbacksChange: vi.fn(),
      onSelectPanel: vi.fn(),
    }),
    container,
  );
  return container;
}

describe("agents overview skeletons", () => {
  it("uses shared stagger classes for loading skeletons", () => {
    const container = renderOverview(true);
    const skeletons = Array.from(container.querySelectorAll<HTMLElement>(".skeleton"));

    expect(skeletons).toHaveLength(6);
    expect(skeletons.map((node) => node.style.animationDelay)).toEqual(["", "", "", "", "", ""]);
    expect(skeletons.map((node) => node.classList.contains("stagger-1"))).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(skeletons.map((node) => node.classList.contains("stagger-2"))).toEqual([
      false,
      true,
      false,
      false,
      true,
      false,
    ]);
    expect(skeletons.map((node) => node.classList.contains("stagger-3"))).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ]);
  });
});
