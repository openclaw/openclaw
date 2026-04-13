/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { PlansViewProps } from "../controllers/plans.ts";
import { renderPlans } from "./plans.ts";

function createProps(overrides: Partial<PlansViewProps> = {}): PlansViewProps {
  return {
    loading: false,
    error: null,
    result: null,
    selectedPlanId: null,
    statusFilter: "all",
    detailLoading: false,
    detailError: null,
    detail: null,
    statusUpdating: false,
    statusError: null,
    onRefresh: () => undefined,
    onSelectPlan: () => undefined,
    onStatusFilterChange: () => undefined,
    onStatusAction: () => undefined,
    ...overrides,
  };
}

describe("renderPlans", () => {
  it("renders available status actions for selected plan", () => {
    const container = document.createElement("div");
    render(
      renderPlans(
        createProps({
          result: {
            count: 1,
            summary: {
              total: 1,
              reviewable: 1,
              terminal: 0,
              byStatus: {
                draft: 0,
                ready_for_review: 1,
                approved: 0,
                rejected: 0,
                archived: 0,
              },
            },
            plans: [
              {
                planId: "plan-1",
                ownerKey: "agent:main:main",
                scopeKind: "session",
                title: "Week 1 orchestration metadata",
                content: "- tools.catalog",
                format: "markdown",
                status: "ready_for_review",
                createdAt: 1,
                updatedAt: Date.now(),
              },
            ],
          },
          selectedPlanId: "plan-1",
          detail: {
            planId: "plan-1",
            ownerKey: "agent:main:main",
            scopeKind: "session",
            title: "Week 1 orchestration metadata",
            content: "- tools.catalog",
            format: "markdown",
            status: "ready_for_review",
            createdAt: 1,
            updatedAt: Date.now(),
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Mark approved");
    expect(container.textContent).toContain("Mark rejected");
  });

  it("calls onStatusAction when lifecycle button is clicked", () => {
    const container = document.createElement("div");
    const onStatusAction = vi.fn();
    render(
      renderPlans(
        createProps({
          onStatusAction,
          result: {
            count: 1,
            summary: {
              total: 1,
              reviewable: 1,
              terminal: 0,
              byStatus: {
                draft: 1,
                ready_for_review: 0,
                approved: 0,
                rejected: 0,
                archived: 0,
              },
            },
            plans: [
              {
                planId: "plan-1",
                ownerKey: "agent:main:main",
                scopeKind: "session",
                title: "Week 1 orchestration metadata",
                content: "- tools.catalog",
                format: "markdown",
                status: "draft",
                createdAt: 1,
                updatedAt: Date.now(),
              },
            ],
          },
          selectedPlanId: "plan-1",
          detail: {
            planId: "plan-1",
            ownerKey: "agent:main:main",
            scopeKind: "session",
            title: "Week 1 orchestration metadata",
            content: "- tools.catalog",
            format: "markdown",
            status: "draft",
            createdAt: 1,
            updatedAt: Date.now(),
          },
        }),
      ),
      container,
    );

    const button = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.includes("Mark ready for review"),
    );
    expect(button).not.toBeUndefined();
    button?.click();
    expect(onStatusAction).toHaveBeenCalledWith("ready_for_review");
  });

  it("calls onStatusFilterChange when changing filter", () => {
    const container = document.createElement("div");
    const onStatusFilterChange = vi.fn();
    render(
      renderPlans(
        createProps({
          onStatusFilterChange,
          result: {
            count: 1,
            summary: {
              total: 1,
              reviewable: 1,
              terminal: 0,
              byStatus: {
                draft: 1,
                ready_for_review: 0,
                approved: 0,
                rejected: 0,
                archived: 0,
              },
            },
            plans: [
              {
                planId: "plan-1",
                ownerKey: "agent:main:main",
                scopeKind: "session",
                title: "Week 1 orchestration metadata",
                content: "- tools.catalog",
                format: "markdown",
                status: "draft",
                createdAt: 1,
                updatedAt: Date.now(),
              },
            ],
          },
        }),
      ),
      container,
    );

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    if (select) {
      select.value = "approved";
      select.dispatchEvent(new Event("change"));
    }
    expect(onStatusFilterChange).toHaveBeenCalledWith("approved");
  });

  it("calls onRefresh when refresh button is clicked", () => {
    const container = document.createElement("div");
    const onRefresh = vi.fn();
    render(renderPlans(createProps({ onRefresh })), container);

    const button = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.includes("Refresh"),
    );
    expect(button).not.toBeUndefined();
    button?.click();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not render lifecycle buttons for archived plans", () => {
    const container = document.createElement("div");
    render(
      renderPlans(
        createProps({
          result: {
            count: 1,
            summary: {
              total: 1,
              reviewable: 0,
              terminal: 1,
              byStatus: {
                draft: 0,
                ready_for_review: 0,
                approved: 0,
                rejected: 0,
                archived: 1,
              },
            },
            plans: [
              {
                planId: "plan-1",
                ownerKey: "agent:main:main",
                scopeKind: "session",
                title: "Archived plan",
                content: "- done",
                format: "markdown",
                status: "archived",
                createdAt: 1,
                updatedAt: Date.now(),
              },
            ],
          },
          selectedPlanId: "plan-1",
          detail: {
            planId: "plan-1",
            ownerKey: "agent:main:main",
            scopeKind: "session",
            title: "Archived plan",
            content: "- done",
            format: "markdown",
            status: "archived",
            createdAt: 1,
            updatedAt: Date.now(),
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("Mark ");
  });
});
