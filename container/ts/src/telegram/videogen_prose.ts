import { soleNonemptyLineStripped } from "./prose_line.js";

const VIDEO_LEAD = "(?:(?:please|can you|could you)\\s+)?";
const VIDEO_VERB = "(?:generate|make|create|animate)";
const VIDEO_NOUN = "(?:video|clip|animation)";
const VIDEO_ADJ =
  "(?:(?:short|quick|little|brief|tiny|cool|cute|funny)|\\d+(?:\\s*|-)(?:s|secs?|seconds?)(?:[- ]long)?)";
const VIDEO_ADJS = `(?:${VIDEO_ADJ}\\s+)*`;
const VIDEO_CONNECTOR = "(?:\\s+(?:of|about|showing|with|where|featuring)\\s+|\\s*[:—–]\\s*)";
const VIDEOGEN_PROSE_RE = new RegExp(
  `^${VIDEO_LEAD}(?:${VIDEO_VERB}(?:\\s+me)?(?:\\s+(?:an?|the|another|some))?\\s+${VIDEO_ADJS}${VIDEO_NOUN}${VIDEO_CONNECTOR}|(?:an?\\s+)?${VIDEO_ADJS}${VIDEO_NOUN}\\s+(?:of|about|showing)\\s+|videogen:?\\s+)(.+?)(?:\\s+please)?$`,
  "i",
);

export function matchVideogenProse(text: string): string | null {
  const line = soleNonemptyLineStripped(text);
  if (line === null) {
    return null;
  }
  const prompt = VIDEOGEN_PROSE_RE.exec(line)?.[1]?.trim() ?? "";
  return prompt || null;
}
