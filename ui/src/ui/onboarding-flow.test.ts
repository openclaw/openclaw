import { describe, expect, it } from "vitest";
import {
  getOnboardingActionState,
  getOnboardingNextStep,
  getOnboardingNextTab,
  getOnboardingProgress,
  getOnboardingStepStatusKey,
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

  it("computes consistent action gating from step state", () => {
    const partial = getOnboardingSteps({
      connected: true,
      channelsLastSuccess: null,
      sessionsCount: 0,
    });
    expect(getOnboardingActionState(partial)).toEqual({
      gatewayReady: true,
      integrationsReady: false,
      firstRunReady: false,
      canOpenChat: false,
      canOpenConsent: false,
    });

    const complete = getOnboardingSteps({
      connected: true,
      channelsLastSuccess: Date.now(),
      sessionsCount: 1,
    });
    expect(getOnboardingActionState(complete)).toEqual({
      gatewayReady: true,
      integrationsReady: true,
      firstRunReady: true,
      canOpenChat: true,
      canOpenConsent: true,
    });
  });

  it("maps step status labels consistently", () => {
    const steps = getOnboardingSteps({
      connected: false,
      channelsLastSuccess: null,
      sessionsCount: 0,
    });
    expect(getOnboardingStepStatusKey(steps[0])).toBe("common.offline");
    expect(getOnboardingStepStatusKey(steps[1])).toBe("common.na");
    expect(getOnboardingStepStatusKey(steps[2])).toBe("common.na");
  });
});
