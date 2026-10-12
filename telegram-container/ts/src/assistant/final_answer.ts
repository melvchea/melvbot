/** Matches a leading echoed per-turn time stamp: "[now: ...]", "Current time: ...", or variants with bold markers. */
const ECHOED_TIME_RE = /^\s*(?:(?:\*\*)?Current time[^:]*:(?:\*\*)?[^\n.]*\.?|\[now:[^\]]*\])[ \t]*\n?/i;

export function stripEchoedTime(text: string): string {
  return text.replace(ECHOED_TIME_RE, "").trim();
}

/** Removes pseudo `<thinking>` text the model wrote into its reply: full spans, an unmatched `</thinking>` with everything before it, an unmatched `<thinking>` with everything after it. */
export function stripThinking(text: string): string {
  let out = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  const close = out.search(/<\/thinking>/i);
  if (close >= 0) {
    out = out.slice(close + "</thinking>".length);
  }
  const open = out.search(/<thinking>/i);
  if (open >= 0) {
    out = out.slice(0, open);
  }
  return out.trim();
}

/**
 * Collects the final answer of a multi-round turn: only the text after the last tool use
 * (pre-tool narration is dropped). Falls back to the last non-empty text when nothing follows the last tool.
 */
export function createFinalAnswerTracker(): {
  add: (text: string, hasToolUse: boolean) => void;
  result: () => string;
} {
  let afterLastTool = "";
  let lastNonEmpty = "";
  return {
    add(text, hasToolUse) {
      if (text.trim()) {
        lastNonEmpty = text;
      }
      if (hasToolUse) {
        afterLastTool = "";
      } else {
        afterLastTool += text;
      }
    },
    result() {
      const chosen = afterLastTool.trim() ? afterLastTool : lastNonEmpty;
      return stripEchoedTime(stripThinking(chosen));
    },
  };
}
