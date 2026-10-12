import { soleNonemptyLineStripped } from "./prose_line.js";

const OCR_OBJECT =
  "(?:(?:this|it|that)|(?:the|this|that|my)\\s+(?:photo|image|picture))";
const OCR_PROSE_RE = new RegExp(
  `^(?:(?:please|can you|could you)\\s+)?ocr(?:\\s+${OCR_OBJECT})?(?:\\s+please)?$`,
  "i",
);

export function matchOcrProse(text: string): boolean {
  const line = soleNonemptyLineStripped(text);
  if (line === null) {
    return false;
  }
  return OCR_PROSE_RE.test(line);
}
