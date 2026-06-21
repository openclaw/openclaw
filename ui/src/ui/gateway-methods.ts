// Shared Gateway hello method lookup for feature-gated UI calls.
import type { GatewayHelloOk } from "./gateway.ts";

export function isGatewayMethodAdvertised(
  host: { hello?: GatewayHelloOk | null },
  method: string,
): boolean | null {
  const methods = host.hello?.features?.methods;
  if (!Array.isArray(methods)) {
    return null;
  }
  return methods.includes(method);
}
