import { delay, googleRetryDelayMs, GOOGLE_RETRY_LIMIT, shouldRetryGoogleStatus } from "../google/retry.js";
import { googleAccessToken } from "../google/token.js";
import { withSheetWriteLock } from "./sheet_lock.js";

export const SHEET_HEADER_FORMAT = 1;

type SpreadsheetCreateResponse = {
  spreadsheetId?: string;
  error?: { message?: string };
};

async function fetchSheets(url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < GOOGLE_RETRY_LIMIT; attempt += 1) {
    const token = await googleAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    response = await fetch(url, { ...init, headers });
    // A POST append may already be applied when Google answers 5xx; only a 429 (rejected) is safe to re-send.
    const unsafeToResend = init.method === "POST" && response.status !== 429;
    if (unsafeToResend || !shouldRetryGoogleStatus(response.status, attempt)) {
      return response;
    }
    await response.arrayBuffer().catch(() => undefined);
    await delay(googleRetryDelayMs(attempt));
  }
  return response!;
}

export function assertSheetHeaders(values: string[][], expected: readonly string[], tab: string): void {
  if (values.length === 0) {
    return;
  }
  const header = values[0] ?? [];
  for (const [index, name] of expected.entries()) {
    if (header[index] !== name) {
      throw new Error(`${tab} header format ${SHEET_HEADER_FORMAT} mismatch at column ${index + 1}`);
    }
  }
}

/** Renames a tab; no-op when `from` is absent (already renamed). */
export async function renameSheetTab(spreadsheetId: string, from: string, to: string): Promise<void> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const meta = await fetchSheets(`${base}?fields=sheets.properties(sheetId,title)`);
  const body = (await meta.json()) as { sheets?: { properties: { sheetId: number; title: string } }[]; error?: { message?: string } };
  if (!meta.ok) {
    throw new Error(body.error?.message ?? "Sheets metadata failed");
  }
  const tab = body.sheets?.find((sheet) => sheet.properties.title === from);
  if (!tab) {
    return;
  }
  const update = await fetchSheets(`${base}:batchUpdate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requests: [{ updateSheetProperties: { properties: { sheetId: tab.properties.sheetId, title: to }, fields: "title" } }],
    }),
  });
  if (!update.ok) {
    throw new Error(((await update.json()) as { error?: { message?: string } }).error?.message ?? "Sheets tab rename failed");
  }
}

export type TabTemplate ={ name: string; headers: readonly string[] };

export async function createSpreadsheet(title: string, tabs: readonly TabTemplate[] = []): Promise<string> {
  const response = await fetchSheets("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      properties: { title },
      ...(tabs.length > 0 ? { sheets: tabs.map((tab) => ({ properties: { title: tab.name } })) } : {}),
    }),
  });
  const body = (await response.json()) as SpreadsheetCreateResponse;
  if (!response.ok || !body.spreadsheetId) {
    throw new Error(body.error?.message ?? "Sheets create failed");
  }
  if (tabs.length > 0) {
    const write = await fetchSheets(
      `https://sheets.googleapis.com/v4/spreadsheets/${body.spreadsheetId}/values:batchUpdate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          valueInputOption: "RAW",
          data: tabs.map((tab) => ({ range: `'${tab.name}'!A1`, values: [[...tab.headers]] })),
        }),
      },
    );
    if (!write.ok) {
      const detail = (await write.json()) as { error?: { message?: string } };
      throw new Error(detail.error?.message ?? "Sheets header write failed");
    }
  }
  return body.spreadsheetId;
}

export async function sheetValues(spreadsheetId: string, tab: string): Promise<string[][]> {
  const range = encodeURIComponent(`'${tab}'`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`;
  const response = await fetchSheets(url);
  const body = (await response.json()) as { values?: unknown[]; error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message ?? "Sheets values.get failed");
  }
  const values = body.values ?? [];
  return values.map((row) =>
    Array.isArray(row) ? row.map((cell) => (cell == null ? "" : String(cell))) : [],
  );
}

export async function sheetValuesBatch(spreadsheetId: string, tabs: readonly string[]): Promise<Map<string, string[][]>> {
  const found = new Map<string, string[][]>();
  if (tabs.length === 0) {
    return found;
  }
  const params = new URLSearchParams();
  for (const tab of tabs) {
    params.append("ranges", `'${tab}'`);
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${params}`;
  const response = await fetchSheets(url);
  const body = (await response.json()) as {
    valueRanges?: Array<{ range?: string; values?: unknown[] }>;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? "Sheets values.batchGet failed");
  }
  for (const [index, tab] of tabs.entries()) {
    const values = body.valueRanges?.[index]?.values ?? [];
    found.set(
      tab,
      values.map((row) => (Array.isArray(row) ? row.map((cell) => (cell == null ? "" : String(cell))) : [])),
    );
  }
  return found;
}

async function sheetsWrite(
  method: "POST" | "PUT",
  url: string,
  values: string[][],
): Promise<void> {
  const response = await fetchSheets(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const body = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message ?? "Sheets write failed");
  }
}

function rowMatches(
  headers: readonly string[],
  expected: Record<string, string | null | undefined>,
  cells: string[],
): boolean {
  return headers.every((header, index) => (expected[header] ?? "") === (cells[index] ?? ""));
}

async function verifyAppendedRow(
  spreadsheetId: string,
  tab: string,
  headers: readonly string[],
  row: Record<string, string | null | undefined>,
): Promise<void> {
  const values = await sheetValues(spreadsheetId, tab);
  const cells = headers.map((header) => row[header] ?? "");
  for (const candidate of values.slice(1).reverse()) {
    if (rowMatches(headers, row, candidate)) {
      return;
    }
  }
  throw new Error(`sheet write verification failed: appended row not found in ${tab}`);
}

async function verifyWrittenRow(
  spreadsheetId: string,
  tab: string,
  headers: readonly string[],
  sheetRow: number,
  row: Record<string, string | null | undefined>,
): Promise<void> {
  const values = await sheetValues(spreadsheetId, tab);
  const cells = values[sheetRow - 1];
  if (!cells || !rowMatches(headers, row, cells)) {
    throw new Error(`sheet write verification failed: row ${sheetRow} in ${tab} does not match`);
  }
}

export async function appendNamed(
  spreadsheetId: string,
  tab: string,
  headers: readonly string[],
  row: Record<string, string | null | undefined>,
): Promise<void> {
  await withSheetWriteLock(spreadsheetId, async () => {
    const range = encodeURIComponent(`'${tab}'!A1`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const cells = headers.map((header) => row[header] ?? "");
    try {
      await sheetsWrite("POST", url, [cells]);
    } catch (error) {
      // The append may have landed before the error (timeout, lost response): keep it if the row is there, never re-send.
      await verifyAppendedRow(spreadsheetId, tab, headers, row).catch(() => {
        throw error;
      });
      return;
    }
    await verifyAppendedRow(spreadsheetId, tab, headers, row);
  });
}

export async function writeNamed(
  spreadsheetId: string,
  tab: string,
  headers: readonly string[],
  sheetRow: number,
  row: Record<string, string | null | undefined>,
): Promise<void> {
  await withSheetWriteLock(spreadsheetId, async () => {
    const range = encodeURIComponent(`'${tab}'!A${sheetRow}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`;
    const cells = headers.map((header) => row[header] ?? "");
    await sheetsWrite("PUT", url, [cells]);
    await verifyWrittenRow(spreadsheetId, tab, headers, sheetRow, row);
  });
}

export function namedRows(values: string[][]): Record<string, string | null>[] {
  if (values.length === 0) {
    return [];
  }
  const headers = values[0] ?? [];
  const rows: Record<string, string | null>[] = [];
  for (const cells of values.slice(1)) {
    const padded = [...cells];
    while (padded.length < headers.length) {
      padded.push("");
    }
    const row: Record<string, string | null> = {};
    for (const [index, header] of headers.entries()) {
      const value = padded[index] ?? "";
      row[header] = value === "" ? null : value;
    }
    rows.push(row);
  }
  return rows;
}
