type APMTEnv = {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
};

export function getApmEnv(): APMTEnv {
  const clientId = process.env.APMT_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.APMT_CLIENT_SECRET?.trim() ?? "";
  const baseUrl = process.env.APMT_BASE_URL?.trim() ?? "https://api-sandbox.apmterminals.com";
  if (!clientId || !clientSecret) {
    throw new Error("APMT credentials missing (APMT_CLIENT_ID / APMT_CLIENT_SECRET)");
  }
  return { clientId, clientSecret, baseUrl };
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getApmToken(): Promise<string> {
  const env = getApmEnv();
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 10_000) return cachedToken.value;

  const tokenUrl = "https://api.apmterminals.com/oauth/client_credential/accesstoken?grant_type=client_credentials";
  const auth = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`APMT auth failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("APMT auth failed: missing access_token");
  const ttlMs = (data.expires_in ?? 300) * 1000;
  cachedToken = { value: data.access_token, expiresAt: now + ttlMs };
  return data.access_token;
}

export async function apmGet(path: string, params: Record<string, string>) {
  const env = getApmEnv();
  const token = await getApmToken();
  const url = new URL(path, env.baseUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const payload = await res.text();
  if (!res.ok) {
    throw new Error(`APMT ${path} failed (${res.status}): ${payload}`);
  }
  return JSON.parse(payload);
}
