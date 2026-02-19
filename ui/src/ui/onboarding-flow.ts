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
