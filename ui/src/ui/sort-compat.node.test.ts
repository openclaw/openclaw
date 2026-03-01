import { describe, expect, it } from "vitest";
import { parseToolSummary } from "./usage-helpers.ts";
import { resolveConfiguredCronModelSuggestions } from "./views/agents-utils.ts";
import { renderNode } from "./views/config-form.node.ts";

async function withToSortedUnavailable(run: () => void | Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  if (descriptor) {
    Reflect.deleteProperty(Array.prototype, "toSorted");
  }

  try {
    await run();
  } finally {
    if (descriptor) {
      // eslint-disable-next-line no-extend-native -- restore Array.prototype after compatibility regression test.
      Object.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  }
}

describe("toSorted compatibility", () => {
  it("collects cron model suggestions when Array.prototype.toSorted is unavailable", async () => {
    await withToSortedUnavailable(() => {
      const result = resolveConfiguredCronModelSuggestions({
        agents: {
          defaults: {
            model: {
              primary: "z-model",
              fallbacks: ["m-model"],
            },
          },
          list: {
            worker: {
              model: "a-model",
            },
          },
        },
      });

      expect(result).toEqual(["a-model", "m-model", "z-model"]);
    });
  });

  it("parses tool summaries when Array.prototype.toSorted is unavailable", async () => {
    await withToSortedUnavailable(() => {
      const summary = parseToolSummary("[Tool: alpha]\n[Tool: beta]\n[Tool: alpha]");
      expect(summary.tools).toEqual([
        ["alpha", 2],
        ["beta", 1],
      ]);
      expect(summary.summary).toContain("alpha");
    });
  });

  it("renders object config nodes when Array.prototype.toSorted is unavailable", async () => {
    await withToSortedUnavailable(() => {
      const rendered = renderNode({
        schema: {
          type: "object",
          properties: {
            zeta: { type: "string" },
            alpha: { type: "string" },
          },
        },
        value: {},
        path: ["root"],
        hints: {
          "root.alpha": { order: 1 },
          "root.zeta": { order: 2 },
        },
        unsupported: new Set<string>(),
        disabled: false,
        onPatch: () => {},
      });

      expect(rendered).toBeTruthy();
    });
  });
});
