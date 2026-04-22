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

export function resolveGatewayHttpAuthHeader(source: GatewayHttpAuthSource): string | null {
  const token = source.settings?.token?.trim();
  if (token) {
    return `Bearer ${token}`;
  }
  const password = source.password?.trim();
  if (password) {
    return `Bearer ${password}`;
  }
  const deviceToken = source.hello?.auth?.deviceToken?.trim();
  if (deviceToken) {
    return `Bearer ${deviceToken}`;
  }
  return null;
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
