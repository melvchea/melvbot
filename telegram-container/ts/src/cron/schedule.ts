/**
 * Mirrors the cron grammar accepted by scripts/install-cron-timers.py
 * (cron_to_systemd_calendar), so a schedule this module accepts is one that
 * script can also turn into a systemd OnCalendar= expression.
 */

export const MIN_AGENT_JOB_INTERVAL_MINUTES = 60;
export const MAX_AGENT_PROMPT_CHARS = 4_000;

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTES_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR;

function parseDigitList(field: string, max: number, label: string): number[] {
  const tokens = field.split(",").map((token) => token.trim());
  const values: number[] = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      throw new Error(`unsupported cron ${label} field: ${field}`);
    }
    const value = Number.parseInt(token, 10);
    if (value < 0 || value > max) {
      throw new Error(`unsupported cron ${label} field: ${field}`);
    }
    values.push(value);
  }
  return values;
}

function parseDowField(field: string): void {
  if (field === "*") {
    return;
  }
  for (const raw of field.split(",")) {
    const token = raw.trim();
    if (/^\d$/.test(token)) {
      const value = Number.parseInt(token, 10);
      if (value < 0 || value > 7) {
        throw new Error(`unsupported cron dow field: ${field}`);
      }
      continue;
    }
    const rangeMatch = /^(\d)-(\d)$/.exec(token);
    if (!rangeMatch) {
      throw new Error(`unsupported cron dow field: ${field}`);
    }
    const [, leftRaw, rightRaw] = rangeMatch;
    const left = Number.parseInt(leftRaw, 10);
    const right = Number.parseInt(rightRaw, 10);
    if (left < 0 || left > 7 || right < 0 || right > 7) {
      throw new Error(`unsupported cron dow field: ${field}`);
    }
  }
}

/**
 * Validates the same 5-field cron grammar install-cron-timers.py accepts:
 * month must be "*"; minute is a digit-only comma list (never "*" or a
 * range); hour is "*" or a digit-only comma list; day-of-month is "*" or one
 * digit; day-of-week is "*" or a comma list of digits/ranges (0-7); and
 * day-of-month and day-of-week can't both be restricted at once.
 */
export function assertValidAgentSchedule(schedule: string): void {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`schedule must have 5 fields: ${schedule}`);
  }
  const [minute, hour, dom, month, dow] = fields;
  if (month !== "*") {
    throw new Error(`unsupported cron month field: ${month}`);
  }
  parseDigitList(minute, 59, "minute");
  if (hour !== "*") {
    parseDigitList(hour, 23, "hour");
  }
  if (dom !== "*") {
    if (!/^\d{1,2}$/.test(dom) || Number.parseInt(dom, 10) < 1 || Number.parseInt(dom, 10) > 31) {
      throw new Error(`unsupported cron day-of-month field: ${dom}`);
    }
    if (dow !== "*") {
      throw new Error(`cron day-of-month and day-of-week can't both be restricted: ${schedule}`);
    }
  }
  parseDowField(dow);
}

function expandField(field: string, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max + 1 }, (_, i) => i);
  }
  return field.split(",").map((token) => Number.parseInt(token.trim(), 10));
}

/** The smallest gap, in minutes, between two runs of this schedule on the same day. */
export function minimumIntervalMinutes(schedule: string): number {
  assertValidAgentSchedule(schedule);
  const [minute, hour] = schedule.trim().split(/\s+/);
  const hours = expandField(hour, HOURS_PER_DAY - 1);
  const minutes = expandField(minute, MINUTES_PER_HOUR - 1);
  const timesOfDay = new Set<number>();
  for (const h of hours) {
    for (const m of minutes) {
      timesOfDay.add(h * MINUTES_PER_HOUR + m);
    }
  }
  const sorted = [...timesOfDay].sort((a, b) => a - b);
  if (sorted.length <= 1) {
    return MINUTES_PER_DAY;
  }
  let minGap = MINUTES_PER_DAY;
  for (let i = 1; i < sorted.length; i += 1) {
    minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
  }
  const wraparound = MINUTES_PER_DAY - sorted[sorted.length - 1] + sorted[0];
  return Math.min(minGap, wraparound);
}

export function assertMinimumInterval(schedule: string): void {
  const minutes = minimumIntervalMinutes(schedule);
  if (minutes < MIN_AGENT_JOB_INTERVAL_MINUTES) {
    throw new Error(
      `schedule runs every ${minutes} minute(s), under the ${MIN_AGENT_JOB_INTERVAL_MINUTES}-minute minimum: ${schedule}`,
    );
  }
}

export function assertAgentPromptLength(prompt: string): void {
  if (prompt.length > MAX_AGENT_PROMPT_CHARS) {
    throw new Error(`prompt is ${prompt.length} chars, over the ${MAX_AGENT_PROMPT_CHARS} cap`);
  }
}
