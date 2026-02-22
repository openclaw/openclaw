export function defaultGatewayUrlFromLocation(
  locationLike: Pick<Location, "protocol" | "host"> = location,
): string {
  const proto = locationLike.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${locationLike.host}`;
}

export function normalizeGatewayUrl(raw: string | null | undefined, fallback: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    }
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
      return parsed.toString();
    }
  } catch {
    // Fall through and try host-only forms below.
  }

  const hostLike = trimmed.replace(/^\/\//, "");
  if (/^[A-Za-z0-9.-]+(?::\d+)?(?:\/.*)?$/.test(hostLike)) {
    return `ws://${hostLike}`;
  }

  return fallback;
}
