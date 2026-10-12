import { soleNonemptyLineStripped } from "./prose_line.js";

const IMAGE_LEAD = "(?:(?:please|can you|could you)\\s+)?";
const IMAGE_VERB = "(?:generate|make|draw|create|paint)";
const IMAGE_NOUN = "(?:image|picture|photo|drawing|illustration)";
const IMAGEGEN_PROSE_RE = new RegExp(
  `^${IMAGE_LEAD}(?:${IMAGE_VERB}(?:\\s+me)?(?:\\s+(?:an?|the))?\\s+${IMAGE_NOUN}\\s+of|imagegen)\\s+(.+?)(?:\\s+please)?$`,
  "i",
);

export function matchImagegenProse(text: string): string | null {
  const line = soleNonemptyLineStripped(text);
  if (line === null) {
    return null;
  }
  const prompt = IMAGEGEN_PROSE_RE.exec(line)?.[1]?.trim() ?? "";
  return prompt || null;
}
