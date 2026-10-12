const TRAILING_NOISE_RE = /[\s.!?\p{Extended_Pictographic}\u200d\ufe0f]+$/u;

export function soleNonemptyLineStripped(text: string): string | null {
  const nonempty = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (nonempty.length !== 1) {
    return null;
  }
  let first = nonempty[0];
  // Trailing punctuation and emoji ("weather?!", "tasks 🙏") do not change the intent.
  first = first.replace(TRAILING_NOISE_RE, "");
  return first || null;
}
