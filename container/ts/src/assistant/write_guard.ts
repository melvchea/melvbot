/**
 * After untrusted content (`web_fetch`, `web_search`, `outlook inbox`) has
 * been read this turn, a write tool call is only allowed if the user's own
 * message this turn asked for that kind of action. This defends against
 * prompt injection: text embedded in a fetched page or an email cannot make
 * the model perform a write the user never asked for.
 */
export const WRITE_ACTION_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "sheet spend add": ["log", "spend", "add", "record", "expense", "charge", "bought", "paid"],
  "sheet spend void": ["void", "undo", "delete", "remove", "cancel"],
  "sheet ev add": ["log", "add", "record", "ev"],
  "sheet ev void": ["void", "undo", "delete", "remove", "cancel"],
  "sheet rules set": ["rule", "set", "change", "update", "policy", "target", "limit"],
  "sheet rules delete": ["rule", "delete", "remove", "clear"],
  "sheet create": ["sheet", "spreadsheet", "create", "new", "make"],
  "note add": ["remember", "note", "save", "write down", "record", "update"],
  "note replace-text": ["remember", "note", "save", "write down", "record", "update", "edit", "change"],
  "note replace-section": ["remember", "note", "save", "write down", "record", "update", "edit", "change"],
  offer_save: ["save", "remember", "keep", "go with", "settle", "decide", "pick"],
  "note rename": ["rename", "title", "call it", "name"],
  "sheet rename": ["rename", "title", "call it", "name"],
  "note delete": ["delete", "remove", "forget"],
  "cron add": ["remind", "schedule", "cron", "recurring", "every"],
  "cron update": ["remind", "schedule", "update", "change"],
  "cron enable": ["enable", "resume", "turn on", "unpause"],
  "cron disable": ["disable", "pause", "stop", "turn off"],
  "cron delete": ["delete", "remove", "cancel"],
  "google tasks create": ["task", "add", "create", "remind"],
  "google tasks update": ["task", "update", "change", "reschedule"],
  "google tasks complete": ["complete", "done", "finished"],
  "google tasks delete": ["task", "delete", "remove", "cancel"],
  "google calendar create": ["calendar", "event", "add", "create", "schedule", "remind"],
  "google calendar update": ["calendar", "event", "update", "change", "reschedule"],
  "google calendar delete": ["calendar", "event", "delete", "remove", "cancel"],
};

export function isGuardedWriteAction(action: string): boolean {
  return action in WRITE_ACTION_KEYWORDS;
}

function matchesAnyKeyword(action: string, message: string): boolean {
  const keywords = WRITE_ACTION_KEYWORDS[action] ?? [];
  const lowered = message.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

/**
 * Throws unless `userMessage` (this turn's own message, never untrusted
 * fetched/emailed content) contains a keyword that matches `action`.
 */
export function assertWriteAllowedAfterUntrusted(action: string, userMessage: string): void {
  if (!isGuardedWriteAction(action)) {
    throw new Error(`write_guard has no keyword rule for action: ${action}`);
  }
  if (!matchesAnyKeyword(action, userMessage)) {
    throw new Error(`refusing ${action}: the user's message this turn did not ask for that action`);
  }
}
