export type GatewayHttpAuthSource = {
  password?: string | null;
  settings?: {
    token?: string | null;
  } | null;
  hello?: {
    auth?: {
      deviceToken?: string | null;
    } | null;
  } | null;
};

export function resolveGatewayHttpAuthHeaders(source: GatewayHttpAuthSource): string[] {
  const candidates = [source.settings?.token, source.password, source.hello?.auth?.deviceToken]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => `Bearer ${value}`);
  return [...new Set(candidates)];
}

export function resolveGatewayHttpAuthHeader(source: GatewayHttpAuthSource): string | null {
  return resolveGatewayHttpAuthHeaders(source)[0] ?? null;
}

export function buildGatewayHttpHeaders(
  source: GatewayHttpAuthSource,
  extraHeaders?: Record<string, string>,
): HeadersInit {
  const authHeader = resolveGatewayHttpAuthHeader(source);
  if (!authHeader) {
    return extraHeaders ?? {};
  }
  return {
    ...extraHeaders,
    Authorization: authHeader,
  };
}
