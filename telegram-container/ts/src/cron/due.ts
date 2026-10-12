const TRIGGERED = "triggered";
const SGT = "Asia/Singapore";

function sgtParts(now: Date): { day: number; weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SGT,
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const num = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const weekdayName = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    day: num("day"),
    weekday: weekdayMap[weekdayName] ?? 0,
    hour: num("hour"),
    minute: num("minute"),
  };
}

function cronField(field: string): Set<number> | null {
  if (field === "*") {
    return null;
  }
  const values = new Set<number>();
  for (const raw of field.split(",")) {
    const token = raw.trim();
    if (!/^\d+$/.test(token)) {
      throw new Error(`unsupported cron field: ${field}`);
    }
    values.add(Number(token));
  }
  return values;
}

function sgtAt(now: Date, hour: number, minute: number): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SGT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return new Date(`${year}-${month}-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);
}

export function todaysSlots(schedule: string, now = new Date()): Date[] {
  const text = schedule.trim();
  if (text.toLowerCase() === TRIGGERED) {
    return [];
  }
  const parts = text.split(/\s+/);
  if (parts.length !== 5) {
    return [];
  }
  const [minuteS, hourS, domS, monthS, dowS] = parts;
  if (monthS !== "*") {
    return [];
  }
  const clock = sgtParts(now);
  const minutes = cronField(minuteS);
  const hours = cronField(hourS);
  const doms = cronField(domS);
  const dows = cronField(dowS);
  if (doms !== null && !doms.has(clock.day)) {
    return [];
  }
  if (dows !== null && !dows.has(clock.weekday)) {
    return [];
  }
  const hourList = [...(hours ?? new Set(Array.from({ length: 24 }, (_, index) => index)))].sort(
    (left, right) => left - right,
  );
  const minuteList = [...(minutes ?? new Set(Array.from({ length: 60 }, (_, index) => index)))].sort(
    (left, right) => left - right,
  );
  return hourList.flatMap((hour) => minuteList.map((minute) => sgtAt(now, hour, minute)));
}

export function latestSlotToday(schedule: string, now = new Date()): Date | null {
  const past = todaysSlots(schedule, now).filter((slot) => slot.getTime() <= now.getTime());
  if (!past.length) {
    return null;
  }
  return past.reduce((best, slot) => (slot > best ? slot : best));
}

export function slotKey(slot: Date): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: SGT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(slot);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}+08:00`;
}

export { TRIGGERED };
