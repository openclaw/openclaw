function isLoopbackIpv4Literal(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) {
    return false;
  }
  for (const octet of octets) {
    if (!/^\d+$/.test(octet)) {
      return false;
    }
    const value = Number(octet);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return false;
    }
  }
  return Number(octets[0]) === 127;
}

function canonicalTrustedLoopbackHost(host: string): string | null {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return "loopback-default";
  }
  if (isLoopbackIpv4Literal(host)) {
    return `ipv4:${host}`;
  }
  return null;
}

export function resolveLoopbackGatewayBootstrapToken(params: {
  gatewayUrl: string;
  bootstrapGatewayToken: string | null;
  pageUrl?: string;
}): string | undefined {
  const candidate = params.bootstrapGatewayToken?.trim();
  if (!candidate) {
    return undefined;
  }
  const pageUrl =
    params.pageUrl ?? (typeof window === "undefined" ? undefined : window.location.href);
  if (!pageUrl) {
    return undefined;
  }
  try {
    const page = new URL(pageUrl);
    const gateway = new URL(params.gatewayUrl, page);
    const pageHost = page.hostname.trim().toLowerCase();
    const gatewayHost = gateway.hostname.trim().toLowerCase();
    const pageLoopbackHost = canonicalTrustedLoopbackHost(pageHost);
    const gatewayLoopbackHost = canonicalTrustedLoopbackHost(gatewayHost);
    if (!pageLoopbackHost || !gatewayLoopbackHost || pageLoopbackHost !== gatewayLoopbackHost) {
      return undefined;
    }
    const pagePort =
      page.port || (page.protocol === "https:" ? "443" : page.protocol === "http:" ? "80" : "");
    const gatewayPort =
      gateway.port ||
      (gateway.protocol === "wss:" ? "443" : gateway.protocol === "ws:" ? "80" : "");
    return pagePort === gatewayPort ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePreferredGatewayAccessToken(params: {
  gatewayUrl?: string | null;
  bootstrapGatewayToken: string | null;
  storedToken?: string | null;
  pageUrl?: string;
}): string | undefined {
  const storedToken = params.storedToken?.trim();
  if (storedToken) {
    return storedToken;
  }
  const bootstrapToken =
    typeof params.gatewayUrl === "string" && params.gatewayUrl.trim().length > 0
      ? resolveLoopbackGatewayBootstrapToken({
          gatewayUrl: params.gatewayUrl,
          bootstrapGatewayToken: params.bootstrapGatewayToken,
          pageUrl: params.pageUrl,
        })
      : undefined;
  if (bootstrapToken) {
    return bootstrapToken;
  }
  return undefined;
}
