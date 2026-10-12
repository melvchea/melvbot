/** Single source of truth for comma commands: the alias map, the builtin set and `,help` all derive from it. */
export const COMMAND_TABLE: readonly { name: string; alias: string; help: string }[] = [
  { name: "restart", alias: "r", help: "restart the bot" },
  { name: "stop", alias: "s", help: "cancel the running turn and queue" },
  { name: "list", alias: "l", help: "shopping list (add items, or OCR the last photo)" },
  { name: "new", alias: "n", help: "start a fresh conversation (or ,  /  , <prompt>)" },
  { name: "status", alias: "st", help: "uptime, doctor, brave, reminders, turns today" },
  { name: "help", alias: "h", help: "this message" },
];

/** Instant (no-model) phrases, shown by `,help`. Whole-message matches only. */
export const INSTANT_PHRASES: readonly string[] = [
  "weather / calendar (tomorrow) / tasks / reminders",
  "make an image|video of ... / ocr this",
  "list notes / list sheets / link to <note>",
  "rename note <x> to <y> / delete note <x> / combine <a> and <b> into <c>",
  "show spend / show ev / store <card> <merchant> $amt / undo (last note change)",
];

const COMMAND_ALIASES: Record<string, string> = Object.fromEntries(COMMAND_TABLE.map((c) => [c.alias, c.name]));

export const BUILTIN_COMMANDS = new Set(COMMAND_TABLE.map((c) => c.name));

/** Text for `,help`, at most 12 lines. */
export function helpText(): string {
  return [
    ...COMMAND_TABLE.map((c) => `,${c.name} (,${c.alias}): ${c.help}`),
    "Instant phrases:",
    ...INSTANT_PHRASES.map((p) => `- ${p}`),
  ].join("\n");
}

export type ParsedCommand = {
  command: string | null;
  args: string;
};

function firstNonemptyLine(
  text: string,
): { firstLine: string; lines: string[]; index: number } | null {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim()) {
      return { firstLine: lines[index], lines, index };
    }
  }
  return null;
}

export function parseCommaCommand(text: string): ParsedCommand {
  const found = firstNonemptyLine(text);
  if (found === null) {
    return { command: null, args: text };
  }
  const stripped = found.firstLine.trimStart();
  if (!stripped.startsWith(",")) {
    return { command: null, args: text };
  }
  // Check if comma is followed by whitespace or end of line
  const afterComma = stripped.slice(1);
  const isNewCommand = afterComma === "" || /^\s/.test(afterComma);
  if (isNewCommand) {
    // Parse args: everything after comma, trimmed, including any following lines
    let args = afterComma.trimStart();
    if (found.index + 1 < found.lines.length) {
      const tail = found.lines.slice(found.index + 1).join("\n");
      args = args ? `${args}\n${tail}` : tail;
    }
    return { command: "new", args };
  }
  // Normal command parsing (comma followed by non-space)
  const tokenAndRest = afterComma.trimStart();
  const space = tokenAndRest.indexOf(" ");
  let typed = (space === -1 ? tokenAndRest : tokenAndRest.slice(0, space)).toLowerCase();
  if (typed.includes("@")) {
    typed = typed.split("@", 1)[0];
  }
  if (!typed) {
    return { command: null, args: text };
  }
  let args = space === -1 ? "" : tokenAndRest.slice(space + 1);
  if (found.index + 1 < found.lines.length) {
    const tail = found.lines.slice(found.index + 1).join("\n");
    args = args ? `${args}\n${tail}` : tail;
  }
  return { command: COMMAND_ALIASES[typed] ?? typed, args };
}

/** Returns the prompt body, or null when the message is empty or starts with a comma. Comma text is commands only. */
export function resolveCommaBind(text: string): string | null {
  const found = firstNonemptyLine(text);
  if (found === null) {
    return null;
  }
  if (found.firstLine.trimStart().startsWith(",")) {
    return null;
  }
  const body = text.trim();
  return body || null;
}

export function isBuiltinCommand(command: string | null): boolean {
  return command !== null && BUILTIN_COMMANDS.has(command);
}
