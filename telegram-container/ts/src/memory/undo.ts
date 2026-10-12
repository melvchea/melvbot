import { loadNotesToml } from "../sheet/toml.js";
import { addNote, getNote, restoreNote, trashCreatedNote } from "../note/notes.js";
import { applyNoteRename } from "../note/note_prose.js";
import { latestUndoableChange, markChangeUndone } from "./change_log.js";

type NoteSnapshot = {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  use_when: string;
  docId: string;
  revision_id?: string;
};

function parseNoteSnapshot(raw: string | null): NoteSnapshot | null {
  return raw ? (JSON.parse(raw) as NoteSnapshot) : null;
}

type UndoResult = { undone: true; action: string; target: string } | { undone: false; reason: string };

/** Reverses the newest Note change for this chat (`MELVBOT_CHAT_KEY`), or any chat when unset. */
export async function undoLastChange(chatKey: string | null = process.env.MELVBOT_CHAT_KEY ?? null): Promise<UndoResult> {
  const entry = latestUndoableChange(chatKey);
  if (!entry) {
    return { undone: false, reason: "nothing to undo" };
  }

  if (entry.action === "note delete") {
    const before = parseNoteSnapshot(entry.beforeJson);
    if (!before) {
      return { undone: false, reason: `change ${entry.id} has no before snapshot` };
    }
    if (loadNotesToml()[before.slug] !== undefined) {
      return { undone: false, reason: `note ${before.slug} exists again; not restoring over it` };
    }
    await restoreNote(before.slug, before.docId);
    markChangeUndone(entry.id);
    return { undone: true, action: entry.action, target: entry.target };
  }

  if (entry.action === "note rename") {
    const before = parseNoteSnapshot(entry.beforeJson);
    if (!before) {
      return { undone: false, reason: `change ${entry.id} has no before snapshot` };
    }
    const renamed = await applyNoteRename(before.slug, before.title);
    if (!renamed.ok) {
      return { undone: false, reason: renamed.message };
    }
    markChangeUndone(entry.id);
    return { undone: true, action: entry.action, target: entry.target };
  }

  const before = parseNoteSnapshot(entry.beforeJson);
  const after = parseNoteSnapshot(entry.afterJson);
  if (!after?.revision_id) {
    return { undone: false, reason: `change ${entry.id} has no revision recorded; cannot verify it is safe to undo` };
  }
  let current: Awaited<ReturnType<typeof getNote>>;
  try {
    current = await getNote(after.slug);
  } catch {
    return { undone: false, reason: `note ${after.slug} no longer exists` };
  }
  if (current.revision_id !== after.revision_id) {
    return {
      undone: false,
      reason: `note ${after.slug} changed since change ${entry.id} (revision ${current.revision_id}, expected ${after.revision_id}); refusing to overwrite`,
    };
  }

  if (before === null) {
    await trashCreatedNote(after.slug);
  } else {
    await addNote({
      slug: before.slug,
      title: before.title,
      body: before.body,
      tags: before.tags,
      useWhen: before.use_when,
      expectRevisionId: after.revision_id,
      skipChangeLog: true,
    });
  }
  markChangeUndone(entry.id);
  return { undone: true, action: entry.action, target: entry.target };
}
