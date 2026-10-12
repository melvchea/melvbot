export type TextLinkEntity = {
  type: "text_link";
  offset: number;
  length: number;
  url: string;
};

export type LinkListMessage = {
  text: string;
  entities: TextLinkEntity[];
};

export function assembleLinkListLines(
  lines: Array<{ label: string; url?: string }>,
  emptyText: string,
): LinkListMessage {
  if (!lines.length) {
    return { text: emptyText, entities: [] };
  }
  const chunks: string[] = [];
  const entities: TextLinkEntity[] = [];
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      chunks.push("\n");
      offset += 1;
    }
    chunks.push(line.label);
    if (line.url) {
      entities.push({
        type: "text_link",
        offset,
        length: line.label.length,
        url: line.url,
      });
    }
    offset += line.label.length;
  }
  return { text: chunks.join(""), entities };
}
