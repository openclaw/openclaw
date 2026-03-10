import type { UiSettings } from "../storage.ts";

export function updateOverviewGatewayUrl(settings: UiSettings, gatewayUrl: string): UiSettings {
  return {
    ...settings,
    gatewayUrl,
  };
}
