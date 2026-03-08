#!/usr/bin/env node
/**
 * twitter-refresh-token.mjs
 * Refreshes the Twitter OAuth 2.0 access token using the refresh token.
 * Writes the new tokens to a file that can be sourced as env vars.
 *
 * Usage:  node scripts/twitter-refresh-token.mjs
 * Env:    TWITTER_REFRESH_TOKEN, TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET
 * Output: Writes updated tokens to /tmp/twitter-tokens.env
 */

import fs from "node:fs";

const TOKEN_FILE = process.env.TWITTER_TOKEN_FILE || "/tmp/twitter-tokens.env";

async function refreshToken() {
  const refreshToken = process.env.TWITTER_REFRESH_TOKEN?.trim();
  const clientId = process.env.TWITTER_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITTER_CLIENT_SECRET?.trim();

  if (!refreshToken) {
    console.error("TWITTER_REFRESH_TOKEN is required");
    process.exit(1);
  }
  if (!clientId) {
    console.error("TWITTER_CLIENT_ID is required");
    process.exit(1);
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };

  if (clientSecret) {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  }

  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Token refresh failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const tokens = await res.json();

  // Write new tokens to env file
  const envContent =
    [
      `TWITTER_BEARER_TOKEN=${tokens.access_token}`,
      `TWITTER_REFRESH_TOKEN=${tokens.refresh_token}`,
    ].join("\n") + "\n";

  fs.writeFileSync(TOKEN_FILE, envContent, { mode: 0o600 });

  // Also export to current process env (for sourcing)
  console.log(`export TWITTER_BEARER_TOKEN="${tokens.access_token}"`);
  console.log(`export TWITTER_REFRESH_TOKEN="${tokens.refresh_token}"`);

  console.error(`Token refreshed. Expires in ${tokens.expires_in}s. Written to ${TOKEN_FILE}`);
}

refreshToken().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
