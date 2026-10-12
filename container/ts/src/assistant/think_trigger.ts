/** Turns that get medium thinking (4096-token budget) for that turn only; reasoning is otherwise off. */
export const THINK_BUDGET_TOKENS = 4096;

export const THINK_PROSE_RULES: readonly { name: string; pattern: RegExp }[] = [
  { name: "compare", pattern: /\b(compare|comparison|vs\.?|versus)\b|\bdifference between\b/i },
  { name: "pros_cons", pattern: /\bpros and cons\b/i },
  { name: "which_better", pattern: /\bwhich (one )?is (better|best|cheaper|faster)\b/i },
  { name: "plan", pattern: /\bplan (my|a|the|our)\b/i },
  { name: "step_by_step", pattern: /\bstep[- ]by[- ]step\b/i },
  { name: "why", pattern: /\bwhy (does|is|do|did|would)\b/i },
  { name: "calculate", pattern: /\b(calculate|how much in total|total cost)\b/i },
  { name: "should_i_or", pattern: /\bshould i\b[^?.!]*\bor\b/i },
  { name: "tradeoffs", pattern: /\btrade-?offs?\b/i },
];

export const THINK_LONG_TEXT_CHARS = 300;

/** Bare confirmations ("yes", "confirm", "ok go ahead") resume a pending action and never need thinking. */
const CONFIRM_RE = /^\s*(?:yes|yep|yeah|y|ok(?:ay)?|sure|confirm(?:ed)?|go ahead|do it|please do|proceed|sounds good)(?:[\s,.!]+(?:please|thanks|go ahead|do it))*[\s.!]*$/i;

export type ThinkTrigger = { think: boolean; rule: string | null; text: string };

/** Decides whether a user turn gets thinking; `think:` prefix is stripped from the returned text. */
export function thinkTrigger(text: string): ThinkTrigger {
  const prefix = /^\s*think:\s*/i.exec(text);
  if (prefix) {
    return { think: true, rule: "prefix", text: text.slice(prefix[0].length) };
  }
  if (CONFIRM_RE.test(text)) {
    return { think: false, rule: null, text };
  }
  for (const rule of THINK_PROSE_RULES) {
    if (rule.pattern.test(text)) {
      return { think: true, rule: rule.name, text };
    }
  }
  if (text.length > THINK_LONG_TEXT_CHARS) {
    return { think: true, rule: "long", text };
  }
  if (/\?[^?]*\w[^?]*\?/.test(text)) {
    return { think: true, rule: "multi_question", text };
  }
  return { think: false, rule: null, text };
}
