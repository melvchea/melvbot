import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadNotesToml, loadSheetsToml } from "../sheet/toml.js";
import { googleAccessToken } from "../google/token.js";
import { GOOGLE_FETCH_TIMEOUT_MS } from "../google/retry.js";
import { titleLine } from "../telegram/title_line.js";

export const BACKUP_KEEP = 8;
const BACKUP_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Dated folder name in Asia/Singapore, e.g. 2026-10-11. */
export function backupDayName(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function backupRoot(): string {
  return path.join(process.env.HOME ?? "/home/melvbot", ".melvbot", "backups");
}

async function googleGet(url: string): Promise<Response> {
  const token = await googleAccessToken();
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Google export failed with status ${response.status}`);
  }
  return response;
}

async function driveExportMarkdown(fileId: string): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/markdown`;
  return (await googleGet(url)).text();
}

/** Sanitized file-name part: letters, digits, dot, dash, underscore only. */
export function safeFilePart(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
}

/** RFC 4180 CSV text for a grid of cell values. */
export function csvText(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","))
    .map((line) => `${line}\n`)
    .join("");
}

/** One CSV per tab of the spreadsheet, named `<label>_<tab>.csv`. */
async function sheetTabCsvs(label: string, spreadsheetId: string): Promise<Array<{ file: string; text: string }>> {
  const meta = (await (await googleGet(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties`)).json()) as {
    sheets?: Array<{ properties?: { title?: string } }>;
  };
  const tabs = (meta.sheets ?? []).map((sheet) => sheet.properties?.title ?? "").filter((title) => title !== "");
  const files: Array<{ file: string; text: string }> = [];
  for (const tab of tabs) {
    const range = encodeURIComponent(`'${tab}'`);
    const values = (await (await googleGet(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${range}`)).json()) as {
      values?: string[][];
    };
    files.push({ file: `sheets/${safeFilePart(label)}_${safeFilePart(tab)}.csv`, text: csvText(values.values ?? []) });
  }
  return files;
}

/** Deletes all but the newest BACKUP_KEEP dated folders under `root`. */
export function pruneBackups(root: string): string[] {
  const days = readdirSync(root).filter((name) => BACKUP_DIR_RE.test(name)).sort().reverse();
  const stale = days.slice(BACKUP_KEEP);
  for (const name of stale) {
    rmSync(path.join(root, name), { recursive: true, force: true });
  }
  return stale;
}

export type BackupFile = { file: string; text: string };

/**
 * Exports every note (Docs -> .md) and every tab of each configured spreadsheet (-> one .csv per tab).
 * One job per note and per sheet; an empty export is a failure. Writes nothing.
 */
export async function collectExports(): Promise<{ files: BackupFile[]; failures: string[]; jobCount: number }> {
  const jobs: Array<{ run: () => Promise<BackupFile[]> }> = [];
  for (const [slug, docId] of Object.entries(loadNotesToml())) {
    jobs.push({
      run: async () => {
        const text = await driveExportMarkdown(docId);
        if (text.trim() === "") {
          throw new Error(`note ${slug} exported empty`);
        }
        return [{ file: `notes/${safeFilePart(slug)}.md`, text }];
      },
    });
  }
  const sheets = loadSheetsToml();
  const sheetIds: Record<string, string> = {
    owner1: sheets.owner1SpreadsheetId,
    owner2: sheets.owner2SpreadsheetId,
    ev: sheets.evSpreadsheetId,
  };
  for (const [name, id] of Object.entries(sheetIds)) {
    jobs.push({
      run: async () => {
        const files = await sheetTabCsvs(name, id);
        if (files.every(({ text }) => text.trim() === "")) {
          throw new Error(`sheet ${name} exported empty`);
        }
        return files;
      },
    });
  }
  const files: BackupFile[] = [];
  const failures: string[] = [];
  for (const job of jobs) {
    try {
      files.push(...(await job.run()));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { files, failures, jobCount: jobs.length };
}

/**
 * Writes collectExports() into root/YYYY-MM-DD, then prunes. Returns the failure message for Telegram, or null on success.
 */
export async function runBackup(now = new Date(), root = backupRoot()): Promise<string | null> {
  const dir = path.join(root, backupDayName(now));
  mkdirSync(dir, { recursive: true });
  const { files, failures, jobCount } = await collectExports();
  for (const { file, text } of files) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  const previousDir = previousBackupDir(root, backupDayName(now));
  const { shrunk, fewerRows } = shrinkAlerts(
    new Map(files.map(({ file, text }) => [file, text])),
    previousDir === null ? new Map() : readBackupFiles(previousDir),
  );
  pruneBackups(root);
  const lines: string[] = [];
  if (failures.length > 0) {
    lines.push(`${failures.length} of ${jobCount} exports failed, first error: ${failures[0]}`);
  }
  if (shrunk.length > 0) {
    lines.push(`notes shrunk over 50%: ${shrunk.join(", ")}`);
  }
  if (fewerRows.length > 0) {
    lines.push(`sheets with fewer rows: ${fewerRows.join(", ")}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return `${titleLine(failures.length > 0 ? "Backup Failed" : "Backup Alert", now)}\n\n${lines.join("\n")}`;
}

export type BackupRestoreReport = {
  day: string;
  same: string[];
  differs: string[];
  missingLive: string[];
  extraLive: string[];
  failures: string[];
  /** Notes whose bytes dropped by more than half since the previous dated backup. */
  shrunk: string[];
  /** Sheet CSVs with fewer rows than in the previous dated backup. */
  fewerRows: string[];
};

/** Saved notes and sheets of one dated folder, keyed `notes/x.md` or `sheets/x.csv`. */
function readBackupFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const sub of ["notes", "sheets"]) {
    if (!existsSync(path.join(dir, sub))) {
      continue;
    }
    for (const name of readdirSync(path.join(dir, sub)).sort()) {
      files.set(`${sub}/${name}`, readFileSync(path.join(dir, sub, name), "utf8"));
    }
  }
  return files;
}

/** Newest dated folder in root that is older than day, or null. */
function previousBackupDir(root: string, day: string): string | null {
  const older = readdirSync(root).filter((name) => BACKUP_DIR_RE.test(name) && name < day).sort();
  return older.length > 0 ? path.join(root, older[older.length - 1]) : null;
}

/** Notes that lost over half their bytes, and sheet CSVs with fewer rows, compared with the previous backup. */
function shrinkAlerts(current: Map<string, string>, previous: Map<string, string>): { shrunk: string[]; fewerRows: string[] } {
  const shrunk: string[] = [];
  const fewerRows: string[] = [];
  for (const [file, text] of current) {
    const before = previous.get(file);
    if (before === undefined) {
      continue;
    }
    if (file.startsWith("notes/") && Buffer.byteLength(text) * 2 < Buffer.byteLength(before)) {
      shrunk.push(file);
    }
    if (file.startsWith("sheets/") && csvRowCount(text) < csvRowCount(before)) {
      fewerRows.push(file);
    }
  }
  return { shrunk: shrunk.sort(), fewerRows: fewerRows.sort() };
}

/** Line count of a csvText() file (each row ends with a newline). */
function csvRowCount(text: string): number {
  return text.split("\n").length - 1;
}

/** Compares the saved root/day folder with a fresh export. Read-only: writes no files and changes nothing in Google. */
export async function backupRestoreReport(day: string, root = backupRoot()): Promise<BackupRestoreReport> {
  if (!BACKUP_DIR_RE.test(day)) {
    throw new Error(`invalid backup day: ${day}`);
  }
  const dir = path.join(root, day);
  if (!existsSync(dir)) {
    throw new Error(`no backup for ${day}`);
  }
  const saved = readBackupFiles(dir);
  const previousDir = previousBackupDir(root, day);
  const alerts = shrinkAlerts(saved, previousDir === null ? new Map() : readBackupFiles(previousDir));
  const { files, failures } = await collectExports();
  const live = new Map(files.map(({ file, text }) => [file, text]));
  const report: BackupRestoreReport = { day, same: [], differs: [], missingLive: [], extraLive: [], failures, ...alerts };
  for (const [file, text] of saved) {
    const liveText = live.get(file);
    if (liveText === undefined) {
      report.missingLive.push(file);
    } else if (liveText === text) {
      report.same.push(file);
    } else {
      report.differs.push(file);
    }
  }
  report.extraLive = [...live.keys()].filter((file) => !saved.has(file)).sort();
  return report;
}
