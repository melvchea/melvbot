/**
 * Removes every match of `pattern`, repeating until nothing matches, so that removing one match
 * cannot leave fragments that join into a new match.
 */
export function removeUntilStable(value: string, pattern: RegExp): string {
  let prev: string;
  do {
    prev = value;
    value = value.replace(pattern, "");
  } while (value !== prev);
  return value;
}

export function stripTags(value: string): string {
  return removeUntilStable(value, /<[^>]+>/g);
}
