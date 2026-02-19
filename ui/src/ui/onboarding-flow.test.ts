import { describe, expect, it } from "vitest";
import {
  getOnboardingNextStep,
  getOnboardingNextTab,
  getOnboardingProgress,
  getOnboardingSteps,
} from "./onboarding-flow.ts";

describe("onboarding flow", () => {
  it("derives ordered steps from gateway and usage state", () => {
    const steps = getOnboardingSteps({
      connected: true,
      channelsLastSuccess: null,
      sessionsCount: 0,
    });

    expect(steps).toEqual([
      { key: "gateway", done: true, tab: "overview" },
      { key: "integrations", done: false, tab: "channels" },
      { key: "firstRun", done: false, tab: "chat" },
    ]);
  });

  it("returns consent as the next tab when onboarding is complete", () => {
    const steps = getOnboardingSteps({
      connected: true,
      channelsLastSuccess: Date.now(),
      sessionsCount: 2,
    });

    expect(getOnboardingProgress(steps)).toEqual({ done: 3, total: 3 });
    expect(getOnboardingNextStep(steps)).toBeNull();
    expect(getOnboardingNextTab(steps)).toBe("consent");
  });
});
