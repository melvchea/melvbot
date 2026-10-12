import { randomBytes } from "node:crypto";

import { clearConfirmations, latestConfirmationCode, saveConfirmation, takeConfirmation } from "./conversation_store.js";

export const CONFIRM_TTL_MS = 10 * 60_000;
const RULES_HEADING = "## Rules";

/** note add on these slugs always needs Confirm, regardless of what changed. */
export const ALWAYS_CONFIRM_NOTE_SLUGS: ReadonlySet<string> = new Set(["about-me", "house-rules"]);

/** Actions (outside note add) that always need Confirm; refused outright in cron. */
export const CONFIRM_REQUIRED_ACTIONS: ReadonlySet<string> = new Set([
  "sheet spend void",
  "sheet ev void",
  "sheet rules set",
  "sheet rules delete",
  "sheet create",
  "note delete",
  "cron add",
  "cron update",
  "cron enable",
  "cron disable",
  "cron delete",
  "google tasks delete",
  "google calendar delete",
]);

export function actionRequiresConfirm(action: string): boolean {
  return CONFIRM_REQUIRED_ACTIONS.has(action);
}

/** Throws for a cron-sourced turn attempting a Confirm-gated action; cron has no one to tap Confirm. */
export function assertConfirmableInSource(action: string, source: "telegram" | "cron"): void {
  if (source === "cron" && actionRequiresConfirm(action)) {
    throw new Error(`refusing ${action} in a cron turn: it requires Confirm`);
  }
}

/** The text of a `## <heading>` section, from just after the heading line to
 * the next `## ` heading or end of body. Empty string when the heading is absent. */
export function extractSection(body: string, heading: string): string {
  const idx = body.indexOf(heading);
  if (idx === -1) {
    return "";
  }
  const after = body.slice(idx + heading.length);
  const nextHeadingMatch = /\n##\s/.exec(after);
  const end = nextHeadingMatch ? nextHeadingMatch.index : after.length;
  return after.slice(0, end).trim();
}

export type LineDiff = { removed: string[]; added: string[] };

/** A standard LCS-based line diff, used to report exactly which lines of a
 * Note changed for the Confirm keyboard's before/after text. */
export function diffLines(before: string, after: string): LineDiff {
  const a = before.split("\n");
  const b = after.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(a[i]);
      i += 1;
    } else {
      added.push(b[j]);
      j += 1;
    }
  }
  while (i < a.length) {
    removed.push(a[i]);
    i += 1;
  }
  while (j < b.length) {
    added.push(b[j]);
    j += 1;
  }
  return { removed, added };
}

/**
 * Whether `note add` on `slug` needs Confirm: always for about-me/house-rules,
 * otherwise only when the `## Rules` section text changed. `oldBody` is null
 * for a brand-new note (nothing to diff against; an absent `## Rules` section
 * on both sides is not a change).
 */
export function noteAddRequiresConfirm(slug: string, oldBody: string | null, newBody: string): boolean {
  if (ALWAYS_CONFIRM_NOTE_SLUGS.has(slug)) {
    return true;
  }
  if (oldBody === null) {
    return true;
  }
  const oldRules = extractSection(oldBody, RULES_HEADING);
  const newRules = extractSection(newBody, RULES_HEADING);
  return oldRules !== newRules;
}

export function buildNoteAddConfirmationSummary(
  slug: string,
  oldBody: string | null,
  newBody: string,
  similarSlugs: string[] = [],
): string {
  if (oldBody === null) {
    const parts = [`Create Note ${slug}?`];
    if (similarSlugs.length > 0) {
      parts.push("", "Similar existing Notes (consider updating instead):", ...similarSlugs.map((hit) => `- ${hit}`));
    }
    return parts.join("\n");
  }
  if (ALWAYS_CONFIRM_NOTE_SLUGS.has(slug)) {
    return `Update Note ${slug}?`;
  }
  const oldRules = extractSection(oldBody, RULES_HEADING);
  const newRules = extractSection(newBody, RULES_HEADING);
  const diff = diffLines(oldRules, newRules);
  const parts = [`Update ## Rules on Note ${slug}?`];
  if (diff.removed.length) {
    parts.push("", "Remove:", ...diff.removed.map((line) => `- ${line}`));
  }
  if (diff.added.length) {
    parts.push("", "Add:", ...diff.added.map((line) => `- ${line}`));
  }
  return parts.join("\n");
}

export type PendingConfirmation = {
  code: string;
  chatKey: string;
  action: string;
  payload: unknown;
  summary: string;
  createdAt: number;
  expiresAt: number;
};

const pending = new Map<string, PendingConfirmation>();

/** Registers a single-use Confirm code, expiring after CONFIRM_TTL_MS. */
export function createConfirmation(
  chatKey: string,
  action: string,
  payload: unknown,
  summary: string,
  now = Date.now(),
): PendingConfirmation {
  const code = randomBytes(6).toString("hex");
  const confirmation: PendingConfirmation = {
    code,
    chatKey,
    action,
    payload,
    summary,
    createdAt: now,
    expiresAt: now + CONFIRM_TTL_MS,
  };
  pending.set(code, confirmation);
  saveConfirmation({
    code,
    chatKey,
    action,
    payloadJson: JSON.stringify(payload ?? null),
    summary,
    createdAt: now,
    expiresAt: confirmation.expiresAt,
  });
  return confirmation;
}

/** Consumes (removes) a Confirm code; returns null if unknown or expired. Always single-use. */
function confirmationFromStore(code: string, now: number): PendingConfirmation | null {
  const stored = takeConfirmation(code);
  if (!stored || now > stored.expiresAt) {
    return null;
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(stored.payloadJson) as unknown;
  } catch {
    payload = null;
  }
  return {
    code: stored.code,
    chatKey: stored.chatKey,
    action: stored.action,
    payload,
    summary: stored.summary,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
  };
}

/** Code of the chat's newest unexpired pending confirmation (every one is also stored in sqlite), or null. Does not consume it. */
export function latestPendingConfirmationCode(chatKey: string, now = Date.now()): string | null {
  return latestConfirmationCode(chatKey, now);
}

export function consumeConfirmation(code: string, now = Date.now()): PendingConfirmation | null {
  const entry = pending.get(code) ?? confirmationFromStore(code, now);
  if (!entry) {
    return null;
  }
  pending.delete(code);
  if (pending.has(code) || entry.code === code) {
    takeConfirmation(code);
  }
  if (now > entry.expiresAt) {
    return null;
  }
  return entry;
}

/** Drops the in-memory map so the next consume must read sqlite. Tests use this for restart. */
export function clearConfirmationCache(): void {
  pending.clear();
}

/** Test-only helper to reset in-memory and stored Confirm codes. */
export function clearAllConfirmations(): void {
  pending.clear();
  clearConfirmations();
}

/** Text shown when a Confirm tap fails; a stale --expect-rev gets a plain explanation instead of the raw CLI error. */
export function confirmFailureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("note revision mismatch")) {
    return "Not saved: this note changed after I prepared the edit (another update was saved first), so I didn't overwrite it. Send the update again and I'll apply it to the current note.";
  }
  return `Failed: ${message}`;
}
