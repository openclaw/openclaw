// Shared helpers for comparing session rows against list defaults.
import type { GatewaySessionRow, SessionsListResult } from "./types.ts";

type SessionModelFields = Pick<GatewaySessionRow, "model" | "modelProvider">;

export function sessionModelMatchesDefaults(
  session: SessionModelFields | null | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
): boolean {
  return (
    (!session?.modelProvider || session.modelProvider === defaults?.modelProvider) &&
    (!session?.model || session.model === defaults?.model)
  );
}
