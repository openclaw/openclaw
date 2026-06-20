// @vitest-environment node
import { describe, expect, it } from "vitest";
import { draftToCronFormPatch, type CronQuickCreateDraft } from "./cron-quick-create.ts";

function createDraft(overrides: Partial<CronQuickCreateDraft> = {}): CronQuickCreateDraft {
  return {
    prompt: "Check inbox",
    name: "Inbox check",
    model: "",
    schedulePreset: "every-morning",
    deliveryPreset: "notify",
    ...overrides,
  };
}

describe("cron quick create", () => {
  it("sets a valid scheduleAt for one-time presets", () => {
    const patch = draftToCronFormPatch(createDraft({ schedulePreset: "once" }));

    expect(patch.scheduleKind).toBe("at");
    expect(patch.deleteAfterRun).toBe(true);
    expect(typeof patch.scheduleAt).toBe("string");
    expect(Date.parse(String(patch.scheduleAt))).not.toBeNaN();
  });

  it("clears deleteAfterRun and scheduleAt for recurring presets", () => {
    const patch = draftToCronFormPatch(createDraft({ schedulePreset: "weekly" }));

    expect(patch.scheduleKind).toBe("cron");
    expect(patch.cronExpr).toBe("0 9 * * 1");
    expect(patch.deleteAfterRun).toBe(false);
    expect(patch.scheduleAt).toBe("");
  });

  it("keeps notify preset announce-capable by targeting an isolated session", () => {
    const patch = draftToCronFormPatch(createDraft({ deliveryPreset: "notify" }));

    expect(patch.sessionTarget).toBe("isolated");
    expect(patch.deliveryMode).toBe("announce");
    expect(patch.wakeMode).toBe("now");
  });

  it("targets main session with systemEvent payload for silent preset (#95073)", () => {
    const patch = draftToCronFormPatch(createDraft({ deliveryPreset: "silent" }));

    expect(patch.sessionTarget).toBe("main");
    expect(patch.payloadKind).toBe("systemEvent");
    expect(patch.deliveryMode).toBe("none");
    expect(patch.wakeMode).toBe("now");
  });

  it("maps a selected model into the cron payload model override", () => {
    const patch = draftToCronFormPatch(createDraft({ model: " openai/gpt-5.2 " }));

    expect(patch.payloadModel).toBe("openai/gpt-5.2");
  });
});
