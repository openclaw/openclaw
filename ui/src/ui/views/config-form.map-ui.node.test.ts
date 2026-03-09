import { describe, expect, it } from "vitest";
import { resolveMapFieldPresentation } from "./config-form.node.ts";

describe("config form map field presentation", () => {
  it("uses account-specific copy for accounts maps", () => {
    expect(resolveMapFieldPresentation(["channels", "feishu", "accounts"])).toEqual({
      label: "Accounts",
      addLabel: "Add Account",
      emptyLabel: "No accounts yet.",
      keyPlaceholder: "Account alias",
      defaultKeyPrefix: "account",
    });
  });

  it("keeps generic copy for non-account maps", () => {
    expect(resolveMapFieldPresentation(["plugins", "entries"])).toEqual({
      label: "Custom entries",
      addLabel: "Add Entry",
      emptyLabel: "No custom entries.",
      keyPlaceholder: "Key",
      defaultKeyPrefix: "custom",
    });
  });
});
