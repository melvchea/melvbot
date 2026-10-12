const TELEGRAM_CHAR_CAP = 4000;
export const INBOX_TOP = 50;
const SCHOOL_SENDER_HOST = "parentsgateway.moe.edu.sg";
const SCHOOL_ACTION = "open Parents Gateway";
const MACHINE_LOCAL = /^(?:no-?reply|donotreply|notifications)(?:\+.+)?$/i;
/** Extra automated-sender hints used only for reply triage (stricter than the digest-wide MACHINE_LOCAL). */
const AUTOMATED_LOCAL =
  /no-?reply|do-?not-?reply|notification|alert|statement|e?advice|billing|invoice|receipt|mailer|bounce|system|automated|newsletter|marketing|promo|^(?:news|info|updates?|support|hello|service|admin|team|contact|orders?|accounts?)$/i;
const AUTOMATED_SUBJECT =
  /\b(?:statements?|billing|invoice|receipt|payment due|ready for viewing|is now available|are ready|e-?advice|lot size|<adv>)\b/i;
const AUTOMATED_NAME = /@|\b(?:billing|notifications?|alerts?|statements?)\b/i;
const CALENDAR_PREFIX =
  /^(updated invitation|invitation|tentatively accepted|accepted|declined|canceled|cancelled):\s*([\s\S]+)$/i;
const MONEY_SUBJECT = /\bcashback\b|\breceipt\b/i;
const MONEY_AMOUNT = /(?:S\$|\$)\s?\d+(?:\.\d{2})?/;
const RECEIPT_SUBJECT = /\breceipt\b/i;
const CASHBACK_SUBJECT = /\bcashback\b/i;
/** At most this many digest Log buttons per digest, so the message never
 * grows an unbounded keyboard. */
export const DIGEST_LOG_BUTTONS_MAX = 5;

/** Reply-needed scoring: a thread is included when its score reaches REPLY_THRESHOLD.
 * Flagged is always enough; "high importance" is enough for humans; direct-to-me
 * alone is not (it needs one more signal); CC-only scores nothing. */
export const REPLY_WEIGHTS = {
  flagged: 3,
  highImportance: 3,
  direct: 2,
  directMany: 1,
  cue: 1,
  knownCorrespondent: 1,
  ongoingThread: 1,
} as const;
export const REPLY_THRESHOLD = 3;
export const REPLY_MAX_LINES = 8;
/** "Direct" means me in To with at most this many recipients (To + CC). */
export const REPLY_DIRECT_MAX_RECIPIENTS = 3;
const DAY_MS = 86_400_000;
const REPLY_CUE =
  /\?|\bcan you\b|\bcould you\b|\bwould you\b|\bplease\b|\blet me know\b|\byour thoughts\b|\bconfirm|\brsvp\b|\bkindly\b|\badvise\b|\brepl(?:y|ies)\b|\brespond\b|\bdeadline\b|\basap\b|\burgent\b|\bby (?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\bby \d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3}/i;
const DUE_HINT =
  /\bby (?:(?:end of|eod|cob)\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\bby (\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\b|\bby ([a-z]{3})[a-z]*\s+(\d{1,2})\b/i;
const AUTO_REPLY_SUBJECT = /^\s*(?:automatic reply|auto(?:matic)?[- ]?reply|out of office)\b|\bout of office\b/i;
const BULK_HEADERS = new Set(["list-unsubscribe", "list-id"]);

const CALENDAR_VERB: Record<string, string> = {
  "updated invitation": "updated",
  invitation: "invited",
  accepted: "accepted",
  "tentatively accepted": "tentatively accepted",
  declined: "declined",
  canceled: "canceled",
  cancelled: "canceled",
};

type Recipient = { emailAddress?: { name?: string; address?: string } };

/** Sent Items row: only what the reply check and known-correspondent set need. */
export type SentMessage = { conversationId?: string; toRecipients?: Recipient[]; sentDateTime?: string };

/** Everything the "Reply needed" section needs besides the digest window itself. */
export type ReplyContext = { me: string; carry: GraphMessage[]; sent: SentMessage[] };

export type GraphMessage = {
  id?: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  importance?: string;
  flag?: { flagStatus?: string };
  bodyPreview?: string;
  inferenceClassification?: string;
  internetMessageHeaders?: { name?: string; value?: string }[];
};

function asSgt(now = new Date()): Date {
  return now;
}

function formatTime(value?: string): string {
  if (!value) {
    return "??:??";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "??:??";
  }
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

function senderName(message: GraphMessage): string {
  const name = message.from?.emailAddress?.name?.trim();
  return name || "Unknown";
}

function senderAddress(message: GraphMessage): string {
  return message.from?.emailAddress?.address?.trim().toLowerCase() ?? "";
}

function headerValue(message: GraphMessage, name: string): string {
  for (const header of message.internetMessageHeaders ?? []) {
    if (String(header.name ?? "").toLowerCase() === name) {
      return String(header.value ?? "");
    }
  }
  return "";
}

function isFocused(message: GraphMessage): boolean {
  return String(message.inferenceClassification ?? "").toLowerCase() === "focused";
}

function isFlagged(message: GraphMessage): boolean {
  return String(message.flag?.flagStatus ?? "").toLowerCase() === "flagged";
}

function isMachineSender(message: GraphMessage): boolean {
  const local = senderAddress(message).split("@")[0] ?? "";
  return MACHINE_LOCAL.test(local);
}

function isNewsletter(message: GraphMessage): boolean {
  for (const name of BULK_HEADERS) {
    if (headerValue(message, name).trim()) {
      return true;
    }
  }
  return /^(bulk|list|junk)$/i.test(headerValue(message, "precedence").trim());
}

function isSchool(message: GraphMessage): boolean {
  return senderAddress(message).endsWith(`@${SCHOOL_SENDER_HOST}`);
}

function isMoney(message: GraphMessage): boolean {
  return MONEY_SUBJECT.test(message.subject ?? "");
}

function parseCalendarSubject(
  subject: string,
): { verb: string; title: string; when: string } | null {
  const match = subject.trim().match(CALENDAR_PREFIX);
  if (!match) {
    return null;
  }
  const verb = CALENDAR_VERB[match[1].toLowerCase()];
  if (!verb) {
    return null;
  }
  const body = match[2].trim();
  const at = body.lastIndexOf(" @ ");
  if (at === -1) {
    return { verb, title: body, when: "" };
  }
  const when = body
    .slice(at + 3)
    .replace(/\s\([^()]*@[^()]*\)\s*$/, "")
    .trim();
  return { verb, title: body.slice(0, at).trim(), when };
}

function calendarLine(message: GraphMessage): { key: string; line: string } {
  const subject = (message.subject ?? "").trim();
  const parsed = parseCalendarSubject(subject);
  if (!parsed) {
    return {
      key: subject.toLowerCase(),
      line: `${senderName(message)} — ${subject || "(no subject)"}`,
    };
  }
  const quoted = `${senderName(message)} ${parsed.verb} "${parsed.title}"`;
  return {
    key: parsed.title.toLowerCase(),
    line: parsed.when ? `${parsed.when} — ${quoted}` : quoted,
  };
}

function schoolLine(message: GraphMessage): string {
  const subject = (message.subject ?? "").replace(/^new post:\s*/i, "").trim() || "(no subject)";
  return `${subject} — ${SCHOOL_ACTION}`;
}

function moneyLine(message: GraphMessage): string {
  const preview = (message.bodyPreview ?? "").replace(/[\u200b-\u200d\ufeff]/g, "");
  const amount = preview.match(MONEY_AMOUNT)?.[0]?.replace(/\s+/g, "");
  const sender = senderName(message);
  if (/\bcashback\b/i.test(message.subject ?? "") && amount) {
    return `${sender} — Cashback confirmed ${amount}`;
  }
  const subject = (message.subject ?? "").trim() || "(no subject)";
  return amount ? `${sender} — ${subject} ${amount}` : `${sender} — ${subject}`;
}

function personLine(message: GraphMessage, count: number): string {
  const suffix = count > 1 ? ` (${count} msgs)` : "";
  return `${formatTime(message.receivedDateTime)} ${senderName(message)} — ${message.subject || "(no subject)"}${suffix}`;
}

function recipientAddresses(list?: Recipient[]): string[] {
  return (list ?? []).map((item) => item.emailAddress?.address?.trim().toLowerCase() ?? "").filter(Boolean);
}

function isAutoGenerated(message: GraphMessage): boolean {
  const auto = headerValue(message, "auto-submitted").trim().toLowerCase();
  return (auto !== "" && auto !== "no") || AUTO_REPLY_SUBJECT.test(message.subject ?? "");
}

function isHuman(message: GraphMessage): boolean {
  return (
    !isNewsletter(message) &&
    !isMachineSender(message) &&
    !AUTOMATED_LOCAL.test(senderAddress(message).split("@")[0] ?? "") &&
    !AUTOMATED_NAME.test(message.from?.emailAddress?.name ?? "") &&
    !isAutoGenerated(message) &&
    !AUTOMATED_SUBJECT.test(message.subject ?? "") &&
    !parseCalendarSubject(message.subject ?? "")
  );
}

function dueHint(text: string): string {
  const match = text.match(DUE_HINT);
  if (!match) {
    return "";
  }
  if (match[1]) {
    return `due ${match[1].slice(0, 1).toUpperCase()}${match[1].slice(1, 3).toLowerCase()}`;
  }
  const day = match[2] ?? match[5];
  const month = (match[3] ?? match[4]).slice(0, 3);
  return `due ${day} ${month.slice(0, 1).toUpperCase()}${month.slice(1).toLowerCase()}`;
}

function waitingLabel(since: Date, now: Date): string {
  const hours = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 3_600_000));
  return hours >= 48 ? `${Math.floor(hours / 24)}d` : hours >= 1 ? `${hours}h` : "<1h";
}

type ReplyItem = { line: string; receivedMs: number; conversationId: string };

/**
 * Threads whose latest message is inbound, not yet answered from Sent Items,
 * and score at least REPLY_THRESHOLD. Oldest waiting first.
 */
export function replyNeededItems(ctx: ReplyContext, now: Date): ReplyItem[] {
  const me = ctx.me.trim().toLowerCase();
  const lastSent = new Map<string, number>();
  const known = new Set<string>();
  const knownSince = now.getTime() - 90 * DAY_MS;
  for (const sent of ctx.sent) {
    const at = Date.parse(sent.sentDateTime ?? "");
    if (!Number.isFinite(at)) {
      continue;
    }
    const key = sent.conversationId ?? "";
    if (key) {
      lastSent.set(key, Math.max(lastSent.get(key) ?? 0, at));
    }
    if (at >= knownSince) {
      for (const address of recipientAddresses(sent.toRecipients)) {
        known.add(address);
      }
    }
  }
  const cutoff = now.getTime() - 14 * DAY_MS;
  const items: ReplyItem[] = [];
  for (const [conversationId, thread] of collapseThreads(ctx.carry)) {
    const inbound = thread.filter(
      (message) => senderAddress(message) !== me && Date.parse(message.receivedDateTime ?? "") >= cutoff,
    );
    const latest = inbound[0];
    if (!latest || (thread[0] !== latest && senderAddress(thread[0]) === me)) {
      continue;
    }
    const receivedMs = Date.parse(latest.receivedDateTime ?? "");
    if ((lastSent.get(conversationId) ?? 0) >= receivedMs) {
      continue;
    }
    const flagged = inbound.some(isFlagged);
    const human = isHuman(latest);
    if (!flagged && !human) {
      continue;
    }
    const tags: string[] = [];
    let score = 0;
    if (flagged) {
      score += REPLY_WEIGHTS.flagged;
      tags.push("flagged");
    } else if (String(latest.importance ?? "").toLowerCase() === "high") {
      score += REPLY_WEIGHTS.highImportance;
      tags.push("important");
    }
    const to = recipientAddresses(latest.toRecipients);
    const cc = recipientAddresses(latest.ccRecipients);
    if (me && to.includes(me)) {
      if (to.length + cc.length <= REPLY_DIRECT_MAX_RECIPIENTS) {
        score += REPLY_WEIGHTS.direct;
        tags.push("direct");
      } else {
        score += REPLY_WEIGHTS.directMany;
      }
    }
    const text = `${latest.subject ?? ""} ${latest.bodyPreview ?? ""}`;
    if (REPLY_CUE.test(text)) {
      score += REPLY_WEIGHTS.cue;
      tags.push("question");
      const due = dueHint(text);
      if (due) {
        tags.push(due);
      }
    }
    if (known.has(senderAddress(latest))) {
      score += REPLY_WEIGHTS.knownCorrespondent;
      tags.push("known");
    }
    if (lastSent.has(conversationId)) {
      score += REPLY_WEIGHTS.ongoingThread;
      tags.push("ongoing");
    }
    if (score < REPLY_THRESHOLD) {
      continue;
    }
    const subject = (latest.subject ?? "").trim() || "(no subject)";
    items.push({
      line: `${senderName(latest)} — ${subject} · ${waitingLabel(new Date(receivedMs), now)} · ${tags.join(", ")}`,
      receivedMs,
      conversationId,
    });
  }
  return items.sort((left, right) => left.receivedMs - right.receivedMs);
}

type Bucket = "fyi" | "calendar" | "school" | "money" | "newsletter" | "other";

function classifyThread(thread: GraphMessage[]): Bucket {
  const latest = thread[0];
  if (parseCalendarSubject(latest.subject ?? "")) {
    return "calendar";
  }
  if (isSchool(latest)) {
    return "school";
  }
  if (isMoney(latest)) {
    return "money";
  }
  if (isNewsletter(latest)) {
    return "newsletter";
  }
  if (isFocused(latest) && !isMachineSender(latest)) {
    return "fyi";
  }
  return "other";
}

function collapseThreads(messages: GraphMessage[]): Map<string, GraphMessage[]> {
  const grouped = new Map<string, GraphMessage[]>();
  for (const message of messages) {
    const key = String(message.conversationId || message.id || "");
    const thread = grouped.get(key) ?? [];
    thread.push(message);
    grouped.set(key, thread);
  }
  for (const thread of grouped.values()) {
    thread.sort((left, right) =>
      String(right.receivedDateTime ?? "").localeCompare(String(left.receivedDateTime ?? "")),
    );
  }
  return grouped;
}

function bucketThreads(threads: Map<string, GraphMessage[]>): {
  fyi: string[];
  calendar: string[];
  school: string[];
  money: string[];
  newsletters: number;
  other: number;
} {
  const fyi: string[] = [];
  const school: string[] = [];
  const money: string[] = [];
  const calendar = new Map<string, string>();
  let newsletters = 0;
  let other = 0;
  const ordered = [...threads.values()].sort((left, right) =>
    String(right[0]?.receivedDateTime ?? "").localeCompare(String(left[0]?.receivedDateTime ?? "")),
  );
  for (const thread of ordered) {
    const latest = thread[0];
    switch (classifyThread(thread)) {
      case "calendar": {
        const item = calendarLine(latest);
        if (!calendar.has(item.key)) {
          calendar.set(item.key, item.line);
        }
        break;
      }
      case "school":
        school.push(schoolLine(latest));
        break;
      case "money":
        money.push(moneyLine(latest));
        break;
      case "newsletter":
        newsletters += 1;
        break;
      case "fyi":
        fyi.push(personLine(latest, thread.length));
        break;
      default:
        other += 1;
    }
  }
  return { fyi, calendar: [...calendar.values()], school, money, newsletters, other };
}

function pushSection(lines: string[], title: string, items: string[]): void {
  if (!items.length) {
    return;
  }
  lines.push(`${title}:`);
  for (const item of items) {
    lines.push(`• ${item}`);
  }
  lines.push("");
}

function skippedLine(newsletters: number, other: number): string {
  const parts: string[] = [];
  if (newsletters) {
    parts.push(`${newsletters} newsletter${newsletters === 1 ? "" : "s"}`);
  }
  if (other) {
    parts.push(`${other} other`);
  }
  return parts.length ? `Skipped: ${parts.join(", ")}` : "";
}

export type DigestReceiptCandidate = { merchant: string; spentOn: string; amount: string };

function isReceiptOnlySubject(message: GraphMessage): boolean {
  const subject = message.subject ?? "";
  return RECEIPT_SUBJECT.test(subject) && !CASHBACK_SUBJECT.test(subject);
}

function receivedDateSgt(value: string | undefined, now = new Date()): string {
  const parsed = value ? new Date(value) : now;
  const clock = Number.isNaN(parsed.getTime()) ? now : parsed;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(clock);
}

/**
 * The receipt lines eligible for a digest Log button: subject says "receipt"
 * (never "cashback", which is already confirmed and has nothing to log) and
 * a dollar amount is present in the preview. Capped at DIGEST_LOG_BUTTONS_MAX.
 */
export function extractReceiptCandidates(messages: GraphMessage[]): DigestReceiptCandidate[] {
  const out: DigestReceiptCandidate[] = [];
  for (const message of messages) {
    if (!isReceiptOnlySubject(message)) {
      continue;
    }
    const preview = (message.bodyPreview ?? "").replace(/[\u200b-\u200d\ufeff]/g, "");
    const rawAmount = preview.match(MONEY_AMOUNT)?.[0];
    if (!rawAmount) {
      continue;
    }
    const amount = rawAmount.replace(/[^\d.]/g, "");
    out.push({ merchant: senderName(message), spentOn: receivedDateSgt(message.receivedDateTime), amount });
    if (out.length >= DIGEST_LOG_BUTTONS_MAX) {
      break;
    }
  }
  return out;
}

export function formatDigestMessage(
  messages: GraphMessage[],
  options: { slot: "morning" | "evening"; now?: Date; truncated?: boolean; reply?: ReplyContext },
): string {
  const clock = asSgt(options.now);
  const replyItems = options.reply ? replyNeededItems(options.reply, clock) : [];
  const replyThreads = new Set(replyItems.map((item) => item.conversationId));
  const threads = collapseThreads(messages);
  const unread = messages.filter((message) => !message.isRead).length;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
      day: "numeric",
      month: "short",
    })
      .formatToParts(clock)
      .map((part) => [part.type, part.value]),
  );
  const stamp = `${parts.weekday} ${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`;
  const suffix = options.truncated ? ` (showing latest ${INBOX_TOP})` : "";
  const header = `Outlook Summary ${stamp}`;
  const counts = `${threads.size} thread${threads.size === 1 ? "" : "s"} ${unread} unread.${suffix}`;
  const shown = new Map([...threads].filter(([key]) => !replyThreads.has(key)));
  const { fyi, calendar, school, money, newsletters, other } = bucketThreads(shown);
  const lines = [header, ""];
  if (replyItems.length) {
    lines.push(`Reply needed (${replyItems.length}):`);
    for (const item of replyItems.slice(0, REPLY_MAX_LINES)) {
      lines.push(`• ${item.line}`);
    }
    if (replyItems.length > REPLY_MAX_LINES) {
      lines.push(`+${replyItems.length - REPLY_MAX_LINES} more`);
    }
    lines.push("");
  } else {
    lines.push("Nothing to reply to.", "");
  }
  pushSection(lines, "Calendar", calendar);
  pushSection(lines, "School", school);
  pushSection(lines, "Money", money);
  pushSection(lines, "FYI", fyi);
  const skipped = skippedLine(newsletters, other);
  if (lines.at(-2) === "Nothing to reply to.") {
    lines.pop(); // footer sits directly under it when no sections follow
  }
  lines.push(skipped ?`${counts} ${skipped}.` : counts);
  const text = lines.join("\n").trim();
  if (text.length > TELEGRAM_CHAR_CAP) {
    return `${text.slice(0, TELEGRAM_CHAR_CAP - 1)}…`;
  }
  return text;
}
