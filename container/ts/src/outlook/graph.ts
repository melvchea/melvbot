import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const OUTLOOK_SCOPES_ALLOWED = new Set([
  "Mail.Read",
  "User.Read",
  "offline_access",
  "openid",
  "profile",
]);
export const OUTLOOK_SCOPES_FORBIDDEN = new Set([
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.Read",
  "Calendars.ReadWrite",
  "Contacts.Read",
  "Contacts.ReadWrite",
  "Tasks.Read",
  "Tasks.ReadWrite",
]);

export function microsoftHome(): string {
  return (
    process.env.MELVBOT_MICROSOFT_HOME ??
    path.join(process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config", "microsoft-home")
  );
}

export function outlookConfigPath(): string {
  return path.join(microsoftHome(), ".outlook-mcp", "config.json");
}

export function outlookAuthPath(): string {
  return path.join(microsoftHome(), ".outlook-mcp", "auth_record.json");
}

export function jwtScopes(accessToken: string): Set<string> {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return new Set();
  }
  let payload = parts[1];
  payload += "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      scp?: string | string[];
      roles?: string | string[];
    };
    const raw = data.scp ?? data.roles ?? "";
    if (Array.isArray(raw)) {
      return new Set(raw.map((item) => String(item).trim()).filter(Boolean));
    }
    return new Set(String(raw).split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function loadOutlookConfig(): Promise<{
  client_id: string;
  tenant_id: string;
  read_only: boolean;
} | null> {
  const file = outlookConfigPath();
  if (!existsSync(file)) {
    return null;
  }
  const payload = JSON.parse(await readFile(file, "utf8")) as {
    client_id?: string;
    tenant_id?: string;
    read_only?: boolean;
  };
  if (!payload.client_id?.trim()) {
    return null;
  }
  return {
    client_id: payload.client_id.trim(),
    tenant_id: payload.tenant_id ?? "consumers",
    read_only: payload.read_only === true,
  };
}

const INBOX_SELECT_FIELDS =
  "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,importance,flag,bodyPreview,inferenceClassification";
const INBOX_SELECT_WITH_HEADERS = `${INBOX_SELECT_FIELDS},internetMessageHeaders`;
const SENT_SELECT_FIELDS = "conversationId,toRecipients,sentDateTime";
/** Reply-needed look-back over the Inbox, and "known correspondent" look-back over Sent Items. */
export const REPLY_LOOKBACK_DAYS = 14;
export const KNOWN_LOOKBACK_DAYS = 90;
const PAGE_SIZE = 100;
const INBOX_MAX_PAGES = 3;
const SENT_MAX_PAGES = 5;
const DAY_MS = 86_400_000;

function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, accept: "application/json" };
}

async function fetchPages(
  accessToken: string,
  firstUrl: string,
  maxPages: number,
): Promise<{ values: unknown[]; status: number; capped: boolean }> {
  const values: unknown[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < maxPages; page += 1) {
    const response = await fetch(url, { headers: authHeaders(accessToken) });
    if (!response.ok) {
      return { values, status: response.status, capped: false };
    }
    const payload = (await response.json()) as { value?: unknown[]; "@odata.nextLink"?: string };
    values.push(...(Array.isArray(payload.value) ? payload.value : []));
    url = payload["@odata.nextLink"];
  }
  return { values, status: 200, capped: Boolean(url) };
}

function folderUrl(folder: string, select: string, filterField: string, sinceIso: string): string {
  const params = new URLSearchParams({
    $select: select,
    $filter: `${filterField} ge ${sinceIso}`,
    $orderby: `${filterField} desc`,
    $top: String(PAGE_SIZE),
  });
  return `${GRAPH_BASE}/me/mailFolders/${folder}/messages?${params}`;
}

async function fetchInboxSince(accessToken: string, sinceIso: string, maxPages: number) {
  let result = await fetchPages(
    accessToken,
    folderUrl("inbox", INBOX_SELECT_WITH_HEADERS, "receivedDateTime", sinceIso),
    maxPages,
  );
  if (result.status === 400) {
    result = await fetchPages(
      accessToken,
      folderUrl("inbox", INBOX_SELECT_FIELDS, "receivedDateTime", sinceIso),
      maxPages,
    );
  }
  if (result.status !== 200) {
    throw new Error(`Graph inbox request failed (HTTP ${result.status})`);
  }
  return result;
}

export async function listInboxMessages(
  accessToken: string,
  windowStartIso: string,
): Promise<{ messages: unknown[]; truncated: boolean }> {
  const { values } = await fetchInboxSince(accessToken, windowStartIso, 1);
  const messages = values.slice(0, 50);
  return { messages, truncated: values.length >= 50 };
}

let cachedMe: string | undefined;

/** The signed-in user's address (Graph /me, User.Read), cached for the process. */
export async function getMyAddress(accessToken: string): Promise<string> {
  if (cachedMe) {
    return cachedMe;
  }
  const response = await fetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) {
    throw new Error(`Graph /me request failed (HTTP ${response.status})`);
  }
  const me = (await response.json()) as { mail?: string; userPrincipalName?: string };
  cachedMe = (me.mail || me.userPrincipalName || "").trim().toLowerCase();
  return cachedMe;
}

/**
 * Inbox of the last REPLY_LOOKBACK_DAYS plus Sent Items of the last
 * KNOWN_LOOKBACK_DAYS (Mail.Read covers both): three requests plus paging.
 */
export async function listReplyContext(
  accessToken: string,
  now = new Date(),
): Promise<{ me: string; carry: unknown[]; sent: unknown[] }> {
  const inboxSince = new Date(now.getTime() - REPLY_LOOKBACK_DAYS * DAY_MS).toISOString();
  const sentSince = new Date(now.getTime() - KNOWN_LOOKBACK_DAYS * DAY_MS).toISOString();
  const [me, inbox, sent] = await Promise.all([
    getMyAddress(accessToken),
    fetchInboxSince(accessToken, inboxSince, INBOX_MAX_PAGES),
    fetchPages(accessToken, folderUrl("sentitems", SENT_SELECT_FIELDS, "sentDateTime", sentSince), SENT_MAX_PAGES),
  ]);
  if (sent.status !== 200) {
    throw new Error(`Graph sent items request failed (HTTP ${sent.status})`);
  }
  return { me, carry: inbox.values, sent: sent.values };
}

export { GRAPH_SCOPE };
