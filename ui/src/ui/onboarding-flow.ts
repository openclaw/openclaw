import type { Tab } from "./navigation.ts";

export type OnboardingStepKey = "gateway" | "integrations" | "firstRun";

export type OnboardingStep = {
  key: OnboardingStepKey;
  done: boolean;
  tab: Tab;
};

export type OnboardingFlowInput = {
  connected: boolean;
  channelsLastSuccess: number | null;
  sessionsCount: number | null;
};

export function getOnboardingSteps(input: OnboardingFlowInput): OnboardingStep[] {
  return [
    { key: "gateway", done: input.connected, tab: "overview" },
    { key: "integrations", done: input.channelsLastSuccess != null, tab: "channels" },
    { key: "firstRun", done: (input.sessionsCount ?? 0) > 0, tab: "chat" },
  ];
}

export function getOnboardingProgress(steps: OnboardingStep[]) {
  const done = steps.filter((step) => step.done).length;
  const total = steps.length;
  return { done, total };
}

export function getOnboardingNextStep(steps: OnboardingStep[]) {
  return steps.find((step) => !step.done) ?? null;
}

export function getOnboardingNextTab(steps: OnboardingStep[]): Tab {
  return getOnboardingNextStep(steps)?.tab ?? "consent";
}

export function getOnboardingStepStatusKey(step: OnboardingStep): "common.ok" | "common.offline" | "common.na" {
  if (step.done) {
    return "common.ok";
  }
  return step.key === "gateway" ? "common.offline" : "common.na";
}

export type OnboardingActionState = {
  gatewayReady: boolean;
  integrationsReady: boolean;
  firstRunReady: boolean;
  canOpenChat: boolean;
  canOpenConsent: boolean;
};

export function getOnboardingActionState(steps: OnboardingStep[]): OnboardingActionState {
  const gatewayReady = steps.some((step) => step.key === "gateway" && step.done);
  const integrationsReady = steps.some((step) => step.key === "integrations" && step.done);
  const firstRunReady = steps.some((step) => step.key === "firstRun" && step.done);

  return {
    gatewayReady,
    integrationsReady,
    firstRunReady,
    canOpenChat: gatewayReady && integrationsReady,
    canOpenConsent: firstRunReady,
  };
}
