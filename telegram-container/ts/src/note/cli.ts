import {
  addNote,
  appendNoteHistory,
  deleteNote,
  describeNote,
  getNote,
  listNotes,
  replaceNoteSection,
  replaceNoteText,
  restoreNote,
} from "./notes.js";
import { loadNotesToml } from "../sheet/toml.js";
import { applyNoteRename } from "./note_prose.js";
import { recordChange } from "../memory/change_log.js";

const NOTE_USAGE =
  "usage: melvbot note add|list|get|delete|restore|describe|append-history|replace-section|replace-text|rename\n" +
  '       melvbot note rename <slug> <new title...>\n' +
  '       melvbot note replace-section <slug> "## Heading" <text> --expect-rev <rev> [--bottom]\n' +
  '       melvbot note replace-text <slug> <old text> <new text> --expect-rev <rev>\n';

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function flags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (const [index, part] of args.entries()) {
    if (part === name && args[index + 1] !== undefined) {
      values.push(args[index + 1]);
    }
  }
  return values;
}

function optionNames(names: string[]): Set<string> {
  return new Set(names);
}

function positionals(args: string[], names: string[]): string[] {
  const named = optionNames(names);
  return args.filter((part, index) => {
    const prev = args[index - 1];
    if (named.has(part)) {
      return false;
    }
    if (prev !== undefined && named.has(prev)) {
      return false;
    }
    return true;
  });
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): number {
  process.stderr.write(NOTE_USAGE);
  return 2;
}

export async function runNoteCli(args: string[]): Promise<number> {
  try {
    if (args[0] === "list") {
      writeJson(await listNotes(flag(args.slice(1), "--tag")));
      return 0;
    }
    if (args[0] === "get") {
      const slug = args[1];
      if (!slug) {
        return usage();
      }
      writeJson(await getNote(slug));
      return 0;
    }
    if (args[0] === "add") {
      const rest = args.slice(1);
      const names = ["--title", "--body", "--tag", "--doc-id", "--use-when", "--expect-rev"];
      const [slug] = positionals(rest, names);
      const title = flag(rest, "--title");
      const body = flag(rest, "--body");
      if (!slug || !title || !body) {
        return usage();
      }
      const useWhen = flag(rest, "--use-when");
      const docId = flag(rest, "--doc-id");
      if (!useWhen?.trim() && docId === undefined && !(slug in loadNotesToml())) {
        throw new Error("use_when is required when creating a note (--use-when)");
      }
      writeJson(
        await addNote({
          slug,
          title,
          body,
          tags: flags(rest, "--tag"),
          docId,
          useWhen,
          expectRevisionId: flag(rest, "--expect-rev"),
        }),
      );
      return 0;
    }
    if (args[0] === "delete") {
      const slug = args[1];
      if (!slug) {
        return usage();
      }
      writeJson(await deleteNote(slug));
      return 0;
    }
    if (args[0] === "restore") {
      const rest = args.slice(1);
      const [slug] = positionals(rest, ["--doc-id"]);
      if (!slug) {
        return usage();
      }
      writeJson(await restoreNote(slug, flag(rest, "--doc-id")));
      return 0;
    }
    if (args[0] === "rename") {
      const [slug, ...titleWords] = args.slice(1);
      const title = titleWords.join(" ").trim();
      if (!slug || !title) {
        return usage();
      }
      const before = (await getNote(slug)).title;
      const result = await applyNoteRename(slug, title);
      if (!result.ok) {
        throw new Error(result.message);
      }
      const changeId = recordChange({
        action: "note rename",
        target: slug,
        before: { slug, title: before },
        after: { slug, title: result.title },
        chatKey: process.env.MELVBOT_CHAT_KEY ?? null,
      });
      writeJson({
        receipt: true,
        action: "note rename",
        target: slug,
        verified: true,
        changeId,
        message: `Renamed Google Doc: ${before} → ${result.title}`,
        before_title: before,
        after_title: result.title,
      });
      return 0;
    }
    if (args[0] === "describe") {
      const rest = args.slice(1);
      const names = ["--add-tag", "--expect-rev"];
      const [slug, useWhen] = positionals(rest, names);
      if (!slug || !useWhen) {
        return usage();
      }
      writeJson(await describeNote(slug, useWhen, flags(rest, "--add-tag"), flag(rest, "--expect-rev")));
      return 0;
    }
    if (args[0] === "replace-section") {
      const bottom = args.includes("--bottom");
      const rest = args.slice(1).filter((part) => part !== "--bottom");
      const [slug, heading, content] = positionals(rest, ["--expect-rev"]);
      if (!slug || !heading || !content) {
        return usage();
      }
      writeJson(
        await replaceNoteSection(slug, heading, content, flag(rest, "--expect-rev"), {
          position: bottom ? "bottom" : "top",
        }),
      );
      return 0;
    }
    if (args[0] === "replace-text") {
      const [slug, oldText, newText] = positionals(args.slice(1), ["--expect-rev"]);
      if (!slug || !oldText || newText === undefined) {
        return usage();
      }
      writeJson(await replaceNoteText(slug, oldText, newText, flag(args, "--expect-rev")));
      return 0;
    }
    if (args[0] === "append-history") {
      const rest = args.slice(1);
      const names = ["--expect-rev"];
      const [slug, text] = positionals(rest, names);
      if (!slug || !text) {
        return usage();
      }
      writeJson(await appendNoteHistory(slug, text, flag(rest, "--expect-rev")));
      return 0;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${detail}\n`);
    return 1;
  }
  return usage();
}
