import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { alertGoogleTokenRefreshFailed } from "./token_alert.js";
import { GOOGLE_FETCH_TIMEOUT_MS } from "./retry.js";

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN_FALLBACK_TTL_SEC = 3600;

export function googleHome(): string {
  const explicit = process.env.MELVBOT_GOOGLE_HOME?.trim();
  if (explicit) {
    return explicit;
  }
  const legacy = process.env.HERMES_HOME?.trim();
  if (legacy) {
    return legacy;
  }
  const configDir = process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config";
  const googleDir = path.join(configDir, "google-home");
  const hermesDir = path.join(configDir, "hermes-home");
  if (!existsSync(googleDir) && existsSync(hermesDir)) {
    return hermesDir;
  }
  return googleDir;
}

export function googleTokenPath(): string {
  const home = googleHome();
  const nested = path.join(home, ".google_auth", "google_token.json");
  const legacy = path.join(home, "google_token.json");
  return existsSync(nested) ? nested : legacy;
}

type TokenPayload = {
  token?: string;
  access_token?: string;
  refresh_token?: string;
  expiry?: string;
  expiry_date?: number;
  token_uri?: string;
  client_id?: string;
  client_secret?: string;
};

function persistRefreshedToken(file: string, payload: TokenPayload, accessToken: string, expiresInSec: number): void {
  const expiryDate = Date.now() + expiresInSec * 1000;
  const next: TokenPayload = {
    ...payload,
    token: accessToken,
    access_token: accessToken,
    expiry_date: expiryDate,
    expiry: new Date(expiryDate).toISOString(),
  };
  const mode = statSync(file).mode;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
}

function accessTokenFrom(payload: TokenPayload): string {
  const token = payload.token ?? payload.access_token;
  if (!token) {
    throw new Error("Google token missing access token");
  }
  return token;
}

function isExpired(payload: TokenPayload): boolean {
  if (payload.expiry_date && Date.now() > payload.expiry_date - 60_000) {
    return true;
  }
  if (payload.expiry) {
    const at = Date.parse(payload.expiry);
    if (Number.isFinite(at) && Date.now() > at - 60_000) {
      return true;
    }
  }
  return !payload.token && !payload.access_token;
}

export async function googleAccessToken(): Promise<string> {
  const file = googleTokenPath();
  if (!existsSync(file)) {
    throw new Error("Google token missing");
  }
  const payload = JSON.parse(readFileSync(file, "utf8")) as TokenPayload;
  if (!isExpired(payload) && (payload.token || payload.access_token)) {
    return accessTokenFrom(payload);
  }
  if (!payload.refresh_token || !payload.client_id || !payload.client_secret) {
    return accessTokenFrom(payload);
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: payload.refresh_token,
    client_id: payload.client_id,
    client_secret: payload.client_secret,
  });
  const response = await fetch(payload.token_uri ?? TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  const json = (await response.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !json.access_token) {
    await alertGoogleTokenRefreshFailed();
    throw new Error("Google token refresh failed");
  }
  const expiresInSec = json.expires_in ?? ACCESS_TOKEN_FALLBACK_TTL_SEC;
  persistRefreshedToken(file, payload, json.access_token, expiresInSec);
  return json.access_token;
}
