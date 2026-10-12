import type { WriteReceipt } from "../memory/change_log.js";

const MAX_DIFF_LINES = 8;
const MAX_LINE_CHARS = 160;

function isWriteReceipt(value: unknown): value is WriteReceipt {
  return typeof value === "object" && value !== null && (value as { receipt?: unknown }).receipt === true;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

function diffLines(prefix: string, lines: string[]): string[] {
  const shown = lines.map((line) => line.trim()).filter(Boolean);
  const head = shown.slice(0, MAX_DIFF_LINES).map((line) => `${prefix} ${clip(line)}`);
  const extra = shown.length - head.length;
  return extra > 0 ? [...head, `${prefix} …and ${extra} more`] : head;
}

const NOTE_VERB_TEXT: Record<string, string> = {
  "note add": "Saved note",
  "note replace-text": "Updated note",
  "note replace-section": "Updated note",
  "note append-history": "Added to note",
};

function bulletBlock(label: string, lines: string[]): string[] {
  const shown = diffLines("•", lines);
  return shown.length > 0 ? ["", `${label}:`, ...shown] : [];
}

export function formatReceipt(receipt: WriteReceipt): string {
  const verb = NOTE_VERB_TEXT[receipt.action];
  const lines = [verb ? `${verb} ${receipt.target}` : `Saved: ${receipt.action} on ${receipt.target}`];
  lines.push(...bulletBlock("Added", receipt.diff?.added ?? []));
  lines.push(...bulletBlock("Removed", receipt.diff?.removed ?? []));
  if (receipt.verified === false) {
    lines.push("Could not verify the write; please check it.");
  }
  if (receipt.url) {
    lines.push(receipt.url);
  }
  return lines.join("\n");
}

/** Turns a CLI write's JSON stdout into a short Telegram message; any other output is returned unchanged. */
export function friendlyCliOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      receipt?: unknown;
      title?: unknown;
      url?: unknown;
      note?: { linked?: unknown; slug?: unknown };
    };
    if (isWriteReceipt(parsed.receipt)) {
      return formatReceipt(parsed.receipt);
    }
    // Handle sheet creation response
    if (typeof parsed.title === "string" && typeof parsed.url === "string") {
      const lines = [`Created sheet "${parsed.title}"`, parsed.url];
      if (parsed.note?.linked === true && typeof parsed.note.slug === "string") {
        lines.push(`Linked from note ${parsed.note.slug}.`);
      }
      return lines.join("\n");
    }
    return googleResultText(parsed as Record<string, unknown>) ?? trimmed;
  } catch {
    return trimmed;
  }
}

const GOOGLE_VERB: Record<string, string> = { created: "created", updated: "updated", completed: "marked done", deleted: "deleted" };

/** Calendar/Tasks write results ({status, taskId|eventId|id, title|summary}) as one plain sentence; null for any other JSON. */
function googleResultText(parsed: Record<string, unknown>): string | null {
  const verb = typeof parsed.status === "string" ? GOOGLE_VERB[parsed.status] : undefined;
  if (!verb) {
    return null;
  }
  const kind = "eventId" in parsed || "summary" in parsed ? "Event" : "taskId" in parsed || "title" in parsed ? "Task" : null;
  if (!kind) {
    return null;
  }
  const name = [parsed.title, parsed.summary].find((value): value is string => typeof value === "string" && value !== "");
  return name ? `${kind} ${verb}: ${name}` : `${kind} ${verb}.`;
}
