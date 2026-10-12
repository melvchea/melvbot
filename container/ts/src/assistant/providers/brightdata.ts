import { ProviderHttpError } from "./http_error.js";

export const BRIGHTDATA_ENV_KEY = "BRIGHTDATA_API_KEY";
export const BRIGHTDATA_ZONE_ENV_KEY = "BRIGHTDATA_ZONE";
export const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";

/** Bright Data Web Unlocker: returns the raw HTML of a URL (callers extract text). */
export async function fetchHtmlViaBrightData(url: string, timeoutMs: number): Promise<string> {
  const apiKey = process.env[BRIGHTDATA_ENV_KEY]?.trim();
  const zone = process.env[BRIGHTDATA_ZONE_ENV_KEY]?.trim();
  if (!apiKey || !zone) {
    throw new Error(`${BRIGHTDATA_ENV_KEY} or ${BRIGHTDATA_ZONE_ENV_KEY} is not set`);
  }
  const response = await fetch(BRIGHTDATA_REQUEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ zone, url, format: "raw" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new ProviderHttpError(response.status, await response.text());
  }
  return response.text();
}
