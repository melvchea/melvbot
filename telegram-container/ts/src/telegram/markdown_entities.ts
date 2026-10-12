import type { TelegramTextEntity } from "./envelope.js";

type Ent = TelegramTextEntity & { url?: string; language?: string };

const LINK_RE = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;
const URL_RE = /^https?:\/\/[^\s]+/;
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function findCloser(s: string, from: number, marker: string): number {
  const single = marker.length === 1;
  for (let j = s.indexOf(marker, from); j !== -1; j = s.indexOf(marker, j + 1)) {
    if (j === from || isSpace(s[j - 1])) {
      continue;
    }
    const next = s[j + marker.length];
    if (single && (s[j + 1] === marker || s[j - 1] === marker)) {
      continue;
    }
    if (marker[0] === "_" || single) {
      if (isAlnum(next)) {
        continue;
      }
    }
    return j;
  }
  return -1;
}

function inline(s: string): { out: string; ents: Ent[] } {
  let out = "";
  const ents: Ent[] = [];
  let i = 0;
  const add = (inner: { out: string; ents: Ent[] }, base: Omit<Ent, "offset" | "length">): void => {
    const offset = out.length;
    for (const e of inner.ents) {
      ents.push({ ...e, offset: e.offset + offset });
    }
    out += inner.out;
    ents.push({ ...base, offset, length: inner.out.length });
  };
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        add({ out: s.slice(i + 1, j), ents: [] }, { type: "code" });
        i = j + 1;
        continue;
      }
    }
    const urlMatch = c === "h" && (i === 0 || !isAlnum(s[i - 1])) ? rest.match(URL_RE) : null;
    if (urlMatch) {
      out += urlMatch[0];
      i += urlMatch[0].length;
      continue;
    }
    if (c === "[") {
      const m = rest.match(LINK_RE);
      if (m) {
        add(inline(m[1]), { type: "text_link", url: m[2] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const double = s[i + 1] === c;
      const marker = double ? c + c : c;
      const prev = s[i - 1];
      const after = s[i + marker.length];
      const openOk =
        !isSpace(after) &&
        after !== c &&
        (c === "*" ? !isAlnum(prev) || double : !isAlnum(prev) && prev !== "_");
      if (openOk) {
        const j = findCloser(s, i + marker.length, marker);
        if (j > i + marker.length) {
          add(inline(s.slice(i + marker.length, j)), { type: double ? "bold" : "italic" });
          i = j + marker.length;
          continue;
        }
      }
    }
    out += c;
    i += 1;
  }
  return { out, ents };
}

/** Converts common Markdown to plain text plus Telegram entities (UTF-16 offsets). */
export function markdownToEntities(markdown: string): { text: string; entities: TelegramTextEntity[] } {
  const lines = markdown.split("\n");
  let text = "";
  const entities: Ent[] = [];
  const append = (line: string, last: boolean): void => {
    text += last ? line : `${line}\n`;
  };
  for (let n = 0; n < lines.length; n += 1) {
    const last = n === lines.length - 1;
    const line = lines[n];
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      let end = -1;
      for (let k = n + 1; k < lines.length; k += 1) {
        if (/^```\s*$/.test(lines[k])) {
          end = k;
          break;
        }
      }
      if (end !== -1) {
        const body = lines.slice(n + 1, end).join("\n");
        if (body.length) {
          const ent: Ent = { type: "pre", offset: text.length, length: body.length };
          if (fence[1]) {
            ent.language = fence[1];
          }
          entities.push(ent);
        }
        append(body, end === lines.length - 1);
        n = end;
        continue;
      }
    }
    let src = line;
    let boldAll = false;
    const heading = src.match(/^#{1,6}\s+(\S.*)$/);
    if (heading) {
      src = heading[1].replace(/\s+#+\s*$/, "");
      boldAll = true;
    } else {
      src = src.replace(/^(\s*)[-*]\s+(?=\S)/, "$1• ");
    }
    const parsed = inline(src);
    const base = text.length;
    for (const e of parsed.ents) {
      entities.push({ ...e, offset: e.offset + base });
    }
    if (boldAll && parsed.out.length) {
      entities.push({ type: "bold", offset: base, length: parsed.out.length });
    }
    append(parsed.out, last);
  }
  entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text, entities };
}
