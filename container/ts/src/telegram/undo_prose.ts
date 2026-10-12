import { undoLastChange } from "../memory/undo.js";

const UNDO_PROSE_RE = /^undo(?: (?:that|it|last change|the last change))?$/;

/** Whole-line "undo" / "undo that" / "undo last change". */
export function matchUndoProse(line: string): boolean {
  return UNDO_PROSE_RE.test(line.trim().toLowerCase());
}

export function undoReply(result: Awaited<ReturnType<typeof undoLastChange>>): string {
  if (result.undone) {
    return `Undid ${result.action}: ${result.target}`;
  }
  return result.reason === "nothing to undo" ? "Nothing to undo." : `Could not undo: ${result.reason}`;
}
