import missionControlConfig from "../../../../mission-control.config.json" with { type: "json" };

type MissionControlConfig = {
  featureFlags?: { missionControl?: boolean };
  workflow?: { stages?: string[]; guardrails?: string[] };
  team?: {
    agents?: Array<{
      id: string;
      displayName: string;
      role: string;
      allowedModes: string[];
      defaultMode?: string;
    }>;
  };
  scoringWeights?: Record<string, number>;
};

export const MC_CONFIG = missionControlConfig as MissionControlConfig;
