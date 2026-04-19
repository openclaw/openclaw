/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderInlinePlanApproval, type InlinePlanApprovalProps } from "./plan-approval-inline.ts";

function createProps(overrides: Partial<InlinePlanApprovalProps> = {}): InlinePlanApprovalProps {
  return {
    request: {
      approvalId: "approval-1",
      sessionKey: "agent:main:user:abc",
      title: "Agent proposed a plan",
      plan: [{ step: "Verify state", status: "pending" }],
      receivedAt: 0,
    },
    connected: true,
    busy: false,
    error: null,
    reviseOpen: false,
    reviseDraft: "",
    onApprove: vi.fn(),
    onAcceptWithEdits: vi.fn(),
    onReviseOpen: vi.fn(),
    onReviseCancel: vi.fn(),
    onReviseDraftChange: vi.fn(),
    onReviseSubmit: vi.fn(),
    onOpenPlan: vi.fn(),
    ...overrides,
  };
}

describe("renderInlinePlanApproval", () => {
  it("renders nothing when there is no pending request", () => {
    const container = document.createElement("div");
    render(
      renderInlinePlanApproval(
        createProps({
          request: null,
        }),
      ),
      container,
    );

    expect(container.textContent).toBe("");
  });

  it("uses the fallback headline for generic titles and keeps the summary visible", () => {
    const container = document.createElement("div");
    render(
      renderInlinePlanApproval(
        createProps({
          request: {
            approvalId: "approval-1",
            sessionKey: "agent:main:user:abc",
            title: "Plan approval requested",
            summary: "Investigate and patch the lifecycle edge cases",
            plan: [{ step: "Check state", status: "pending" }],
            receivedAt: 0,
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Agent proposed a plan");
    expect(container.textContent).toContain("Investigate and patch the lifecycle edge cases");
    expect(container.textContent).toContain("1 step");
  });

  it("wires plan action buttons to the provided handlers", () => {
    const container = document.createElement("div");
    const onApprove = vi.fn();
    const onAcceptWithEdits = vi.fn();
    const onReviseOpen = vi.fn();
    const onOpenPlan = vi.fn();
    render(
      renderInlinePlanApproval(
        createProps({
          onApprove,
          onAcceptWithEdits,
          onReviseOpen,
          onOpenPlan,
        }),
      ),
      container,
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    buttons.find((button) => button.textContent?.includes("Open plan"))?.click();
    buttons.find((button) => button.textContent?.includes("Accept, allow edits"))?.click();
    buttons.find((button) => button.textContent?.trim() === "Accept")?.click();
    buttons.find((button) => button.textContent?.trim() === "Revise")?.click();

    expect(onOpenPlan).toHaveBeenCalledOnce();
    expect(onAcceptWithEdits).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReviseOpen).toHaveBeenCalledOnce();
  });

  it("renders the revise editor and routes draft updates plus keyboard shortcuts", () => {
    const container = document.createElement("div");
    const onReviseDraftChange = vi.fn();
    const onReviseSubmit = vi.fn();
    const onReviseCancel = vi.fn();
    render(
      renderInlinePlanApproval(
        createProps({
          reviseOpen: true,
          reviseDraft: "Please tighten the rollback path",
          onReviseDraftChange,
          onReviseSubmit,
          onReviseCancel,
        }),
      ),
      container,
    );

    const textarea = container.querySelector<HTMLTextAreaElement>(
      ".plan-inline-card__revise-input",
    );
    expect(textarea).not.toBeNull();
    textarea!.value = "Updated feedback";
    textarea!.dispatchEvent(new Event("input"));
    textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onReviseDraftChange).toHaveBeenCalledWith("Updated feedback");
    expect(onReviseSubmit).toHaveBeenCalledOnce();
    expect(onReviseCancel).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Send revision");
  });

  it("shows an offline warning and disables plan actions when disconnected", () => {
    const container = document.createElement("div");
    render(
      renderInlinePlanApproval(
        createProps({
          connected: false,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Reconnect to resolve this plan.");
    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>("button.plan-inline-card__btn"),
    ];
    expect(buttons).not.toHaveLength(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("renders a warning and disables options when the question handler is missing", () => {
    const container = document.createElement("div");
    render(
      renderInlinePlanApproval(
        createProps({
          request: {
            approvalId: "approval-q",
            sessionKey: "agent:main:user:abc",
            title: "Agent has a question",
            plan: [],
            receivedAt: 0,
            question: {
              prompt: "Which option should we choose?",
              options: ["A", "B"],
            },
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Question handler not wired");
    const optionButtons = [
      ...container.querySelectorAll<HTMLButtonElement>("button.plan-inline-card__btn"),
    ];
    expect(optionButtons).not.toHaveLength(0);
    expect(optionButtons.every((button) => button.disabled)).toBe(true);
  });

  it("shows the question offline warning and disables answer buttons when disconnected", () => {
    const container = document.createElement("div");
    render(
      renderInlinePlanApproval(
        createProps({
          connected: false,
          request: {
            approvalId: "approval-q",
            sessionKey: "agent:main:user:abc",
            title: "Agent has a question",
            plan: [],
            receivedAt: 0,
            question: {
              prompt: "Which option should we choose?",
              options: ["A", "B"],
            },
          },
          onAnswerOption: vi.fn(),
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Reconnect to answer this question.");
    const optionButtons = [
      ...container.querySelectorAll<HTMLButtonElement>("button.plan-inline-card__btn"),
    ];
    expect(optionButtons).not.toHaveLength(0);
    expect(optionButtons.every((button) => button.disabled)).toBe(true);
  });

  it("routes question option clicks and the Other affordance through the supplied handlers", () => {
    const container = document.createElement("div");
    const onAnswerOption = vi.fn();
    const onQuestionOtherOpen = vi.fn();
    render(
      renderInlinePlanApproval(
        createProps({
          request: {
            approvalId: "approval-q",
            sessionKey: "agent:main:user:abc",
            title: "Agent has a question",
            plan: [],
            receivedAt: 0,
            question: {
              prompt: "Which option should we choose?",
              options: ["A", "B"],
              allowFreetext: true,
            },
          },
          onAnswerOption,
          onQuestionOtherOpen,
        }),
      ),
      container,
    );

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>("button.plan-inline-card__btn"),
    ];
    buttons.find((button) => button.textContent?.trim() === "A")?.click();
    buttons.find((button) => button.textContent?.includes("Other"))?.click();

    expect(onAnswerOption).toHaveBeenCalledWith("A");
    expect(onQuestionOtherOpen).toHaveBeenCalledOnce();
  });

  it("renders the free-text answer editor and routes submit plus cancel", () => {
    const container = document.createElement("div");
    const onQuestionOtherDraftChange = vi.fn();
    const onQuestionOtherSubmit = vi.fn();
    const onQuestionOtherCancel = vi.fn();
    render(
      renderInlinePlanApproval(
        createProps({
          request: {
            approvalId: "approval-q",
            sessionKey: "agent:main:user:abc",
            title: "Agent has a question",
            plan: [],
            receivedAt: 0,
            question: {
              prompt: "Which option should we choose?",
              options: ["A", "B"],
              allowFreetext: true,
            },
          },
          onAnswerOption: vi.fn(),
          questionOtherOpen: true,
          questionOtherDraft: "Custom answer",
          onQuestionOtherDraftChange,
          onQuestionOtherSubmit,
          onQuestionOtherCancel,
        }),
      ),
      container,
    );

    const textarea = container.querySelector<HTMLTextAreaElement>(
      ".plan-inline-card__revise-input",
    );
    expect(textarea).not.toBeNull();
    textarea!.value = "Updated custom answer";
    textarea!.dispatchEvent(new Event("input"));
    textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    container.querySelectorAll<HTMLButtonElement>("button.plan-inline-card__btn").item(0).click();
    container.querySelectorAll<HTMLButtonElement>("button.plan-inline-card__btn").item(1).click();

    expect(onQuestionOtherDraftChange).toHaveBeenCalledWith("Updated custom answer");
    expect(onQuestionOtherSubmit).toHaveBeenCalledTimes(2);
    expect(onQuestionOtherCancel).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Back to options");
  });
});
