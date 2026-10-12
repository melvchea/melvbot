import { markdownToEntities } from "./markdown_entities.js";

export type TelegramTextEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
};

export type TelegramParts = {
  header?: string;
  body?: string;
  footer?: string;
  /** Render Markdown in the body (bold, italic, code, links, headings, bullets) as entities. */
  markdown?: boolean;
};

export type AssembledTelegram = {
  text: string;
  entities: TelegramTextEntity[];
};

export function formatTopicHeader(label: string | undefined): string {
  const trimmed = label?.trim();
  if (!trimmed) {
    return "";
  }
  return `"${trimmed}"`;
}

export function assembleTelegram(parts: TelegramParts): AssembledTelegram {
  const chunks: string[] = [];
  const entities: TelegramTextEntity[] = [];
  let length = 0;
  const push = (chunk: string, chunkEntities: TelegramTextEntity[] = []): void => {
    const offset = length > 0 ? length + 2 : 0;
    for (const e of chunkEntities) {
      entities.push({ ...e, offset: e.offset + offset });
    }
    chunks.push(chunk);
    length = offset + chunk.length;
  };
  if (parts.header?.trim()) {
    push(parts.header.trim());
  }
  if (parts.body?.trim()) {
    const body = parts.body.trim();
    let rendered: { text: string; entities: TelegramTextEntity[] } | null = null;
    if (parts.markdown) {
      try {
        rendered = markdownToEntities(body);
      } catch (error) {
        console.error("markdownToEntities failed", error);
      }
    }
    if (rendered && rendered.text.trim()) {
      push(rendered.text, rendered.entities);
    } else {
      push(body);
    }
  }
  const footer = parts.footer?.trim() ?? "";
  if (footer) {
    push(footer, [{ type: "code", offset: 0, length: footer.length }]);
  }
  return { text: chunks.join("\n\n"), entities };
}
