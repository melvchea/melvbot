const PREFIX = "Start with one title line: Weekly reminder for";
const MONTHLY_RE = /^If today is also the (\d{1,2})(?:st|nd|rd|th)?\b/i;

export function isWeeklyReminderPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(PREFIX);
}

function bullets(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith("•")).map((line) => line.trim());
}

/** Weekly bullets, plus the monthly bullets keyed by day of month, as written in the job prompt. */
export function parseWeeklyReminderPrompt(prompt: string): { weekly: string[]; monthly: Map<number, string[]> } {
  const weekly: string[] = [];
  const monthly = new Map<number, string[]>();
  let current: string[] = weekly;
  for (const raw of prompt.split(/\r?\n/)) {
    const line = raw.trim();
    const monthlyHeader = MONTHLY_RE.exec(line);
    if (monthlyHeader) {
      current = [];
      monthly.set(Number(monthlyHeader[1]), current);
    } else if (line.startsWith("•")) {
      current.push(line);
    } else if (line.startsWith("On a normal")) {
      current = [];
    }
  }
  return { weekly: bullets(weekly), monthly };
}

function sgtParts(now: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Singapore", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
}

function reminderTitle(label: string, parts: Record<string, string>): string {
  return `${label} ${parts.weekday} ${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`;
}

/** Title line (Asia/Singapore date) plus weekly bullets, with the monthly bullets when today is their day. */
export function renderWeeklyReminder(prompt: string, now: Date): string {
  const parts = sgtParts(now);
  const { weekly, monthly } = parseWeeklyReminderPrompt(prompt);
  const extra = monthly.get(Number(parts.day)) ?? [];
  return [reminderTitle("Weekly Reminder", parts), "", ...weekly, ...extra].join("\n");
}

const MONTHLY_JOB_RE = /^Use the Asia\/Singapore calendar date[\s\S]*?reply exactly \[SILENT\][\s\S]*?send only this \S+-of-month list/i;

export function isMonthlyReminderPrompt(prompt: string): boolean {
  return MONTHLY_JOB_RE.test(prompt.trimStart());
}

const MONTHLY_FROM_WEEKLY = "Monthly reminders from the Saturday Reminder job";

export function isMonthlyFromWeeklyPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(MONTHLY_FROM_WEEKLY);
}

/** Single daily job: the monthly bullets live only in the Saturday Reminder prompt. Null on Saturday (already merged there) or when today has none. */
export function renderMonthlyFromWeekly(weeklyPrompt: string, now: Date): string | null {
  const parts = sgtParts(now);
  const items = parts.weekday === "Sat" ? [] : (parseWeeklyReminderPrompt(weeklyPrompt).monthly.get(Number(parts.day)) ?? []);
  return items.length === 0 ? null : [reminderTitle("Monthly Reminder", parts), "", ...items].join("\n");
}

/** Monthly 1st/14th job: null on Saturday (the weekly reminder already carries these bullets), else title plus the prompt's bullets. */
export function renderMonthlyReminder(prompt: string, now: Date): string | null {
  const parts = sgtParts(now);
  if (parts.weekday === "Sat") {
    return null;
  }
  return [reminderTitle("Monthly Reminder", parts), "", ...bullets(prompt.split(/\r?\n/).map((line) => line.trim()))].join("\n");
}
