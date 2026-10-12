import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadOutlookConfig, microsoftHome, outlookAuthPath } from "./graph.js";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const CACHE_NAME = "outlook-mcp.nocae";

function cachePath(): string {
  return path.join(microsoftHome(), ".IdentityService", CACHE_NAME);
}

function extractRefreshToken(cache: unknown): string | null {
  if (!cache || typeof cache !== "object") {
    return null;
  }
  const refresh = (cache as { RefreshToken?: Record<string, { secret?: string }> }).RefreshToken;
  if (!refresh) {
    return null;
  }
  for (const entry of Object.values(refresh)) {
    if (entry?.secret) {
      return entry.secret;
    }
  }
  return null;
}

export async function getGraphAccessToken(): Promise<string> {
  const config = await loadOutlookConfig();
  if (!config) {
    throw new Error("Outlook config missing");
  }
  if (!existsSync(outlookAuthPath())) {
    throw new Error("Outlook token expired (re-run outlook-mcp auth)");
  }
  if (!existsSync(cachePath())) {
    throw new Error("Outlook token cache missing");
  }
  const cache = JSON.parse(readFileSync(cachePath(), "utf8")) as unknown;
  const refresh = extractRefreshToken(cache);
  if (!refresh) {
    throw new Error("Outlook refresh token missing");
  }
  const body = new URLSearchParams({
    client_id: config.client_id,
    grant_type: "refresh_token",
    refresh_token: refresh,
    scope: GRAPH_SCOPE,
  });
  const response = await fetch(
    `https://login.microsoftonline.com/${config.tenant_id}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!response.ok) {
    throw new Error("Outlook token unavailable");
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("Outlook token unavailable");
  }
  return payload.access_token;
}
