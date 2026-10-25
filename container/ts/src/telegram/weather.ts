const FORECAST_24H =
  "https://api.data.gov.sg/v1/environment/24-hour-weather-forecast";
const FORECAST_2H =
  "https://api.data.gov.sg/v1/environment/2-hour-weather-forecast";
const PM25_URL = "https://api-open.data.gov.sg/v2/real-time/api/pm25";
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "melvbot-weather/1.0";
const SGT = "Asia/Singapore";
const WEATHER_DAY_START_HOUR = 6;
const WEATHER_DAY_END_HOUR = 22;
const PM25_NORMAL_MAX = 55;
const PM25_ELEVATED_MAX = 150;
const PM25_HIGH_MAX = 250;
const NOWCAST_HOURS = 2;
const ROUTINE_HOURS = 4;
const MAX_NAMED_TOWNS = 5;
const WIDE_RAIN_REGIONS = 4;
const WIDE_RAIN_TOWNS = 8;
const RAIN_CHANCE_THUNDER = 80;
const RAIN_CHANCE_WIDE = 60;
const RAIN_CHANCE_SOME = 40;
const REGION_ORDER = ["north", "south", "east", "west", "central"] as const;
const RAIN_TOKENS = ["shower", "rain", "thunder", "drizzle", "storm"] as const;
const DAY_NIGHT = /\s*\((?:Day|Night)\)\s*/gi;
const REGION_TOWNS: Record<(typeof REGION_ORDER)[number], readonly string[]> = {
  north: ["Woodlands", "Yishun", "Sembawang", "Ang Mo Kio"],
  south: ["City", "Queenstown", "Bukit Merah", "Sentosa"],
  east: ["Bedok", "Tampines", "Pasir Ris", "Changi"],
  west: ["Jurong West", "Clementi", "Choa Chu Kang", "Tuas"],
  central: ["Bishan", "Toa Payoh", "Novena", "Serangoon"],
};
const AREA_REGION: Record<string, (typeof REGION_ORDER)[number]> = {
  "Ang Mo Kio": "north",
  Mandai: "north",
  Seletar: "north",
  Sembawang: "north",
  "Sungei Kadut": "north",
  Woodlands: "north",
  Yishun: "north",
  "Bukit Merah": "south",
  City: "south",
  Queenstown: "south",
  Sentosa: "south",
  "Southern Islands": "south",
  Bedok: "east",
  Changi: "east",
  Geylang: "east",
  "Marine Parade": "east",
  "Pasir Ris": "east",
  "Paya Lebar": "east",
  "Pulau Tekong": "east",
  "Pulau Ubin": "east",
  Tampines: "east",
  "Boon Lay": "west",
  "Bukit Batok": "west",
  "Bukit Panjang": "west",
  "Choa Chu Kang": "west",
  Clementi: "west",
  "Jalan Bahar": "west",
  "Jurong East": "west",
  "Jurong Island": "west",
  "Jurong West": "west",
  "Lim Chu Kang": "west",
  Pioneer: "west",
  Tengah: "west",
  Tuas: "west",
  "Western Islands": "west",
  "Western Water Catchment": "west",
  Bishan: "central",
  "Bukit Timah": "central",
  "Central Water Catchment": "central",
  Hougang: "central",
  Kallang: "central",
  Novena: "central",
  Punggol: "central",
  Sengkang: "central",
  Serangoon: "central",
  Tanglin: "central",
  "Toa Payoh": "central",
};

type SgtParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function sgtParts(now: Date): SgtParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SGT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const num = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
    second: num("second"),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function sgtHour(now: Date): number {
  return sgtParts(now).hour;
}

function dateTimeQuery(at: Date): string {
  const parts = sgtParts(at);
  const stamp = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
  return `?date_time=${encodeURIComponent(stamp)}`;
}

async function fetchJson(url: string, at?: Date): Promise<Record<string, unknown>> {
  const target = at ? `${url}${dateTimeQuery(at)}` : url;
  const response = await fetch(target, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`NEA weather fetch failed: ${target}`);
  }
  const payload = (await response.json()) as { items?: Record<string, unknown>[] };
  const item = payload.items?.[0];
  if (!item) {
    throw new Error(`NEA weather fetch empty: ${target}`);
  }
  return item;
}

export async function fetchNowcastItem(now: Date): Promise<Record<string, unknown>> {
  return fetchJson(FORECAST_2H, now);
}

export function nowcastHasRain(
  nowcast: Record<string, unknown> | null | undefined,
  now: Date,
): boolean {
  return nowcastRainTowns(nowcast, now).length > 0;
}

export async function fetchPm25Item(): Promise<Record<string, unknown> | null> {
  const response = await fetch(PM25_URL, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`NEA PM2.5 fetch failed: ${PM25_URL}`);
  }
  const payload = (await response.json()) as {
    data?: { items?: Record<string, unknown>[] };
  };
  return payload.data?.items?.[0] ?? null;
}

function intField(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

function parseSgt(value: unknown): Date | null {
  if (!value || typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRain(text: string): boolean {
  const lower = text.toLowerCase();
  return RAIN_TOKENS.some((token) => lower.includes(token));
}

function cleanConditions(text: string): string {
  const cleaned = text.replace(DAY_NIGHT, "").trim() || "Fair";
  if (cleaned.toLowerCase() === cleaned) {
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
}

function pickConditions(texts: Iterable<string>): string {
  const cleaned = [...texts].map((text) => cleanConditions(String(text))).filter((text) => text.trim());
  if (cleaned.length === 0) {
    return "Fair";
  }
  const rainy = cleaned.filter(isRain);
  const pool = rainy.length ? rainy : cleaned;
  const counts = new Map<string, number>();
  for (const text of pool) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  let best = pool[0];
  let bestCount = counts.get(best) ?? 0;
  const seen = new Set<string>([best]);
  for (const text of pool) {
    if (seen.has(text)) {
      continue;
    }
    seen.add(text);
    const count = counts.get(text) ?? 0;
    if (count > bestCount) {
      best = text;
      bestCount = count;
    }
  }
  return best;
}

function nowcastCoversNow(
  nowcast: Record<string, unknown> | null | undefined,
  now: Date,
): boolean {
  if (!nowcast) {
    return false;
  }
  const valid = (nowcast.valid_period as { start?: string; end?: string } | undefined) ?? {};
  const end = parseSgt(valid.end);
  if (end === null) {
    return true;
  }
  return now < end;
}

function nowcastRainTowns(
  nowcast: Record<string, unknown> | null | undefined,
  now: Date,
): [string, string][] {
  if (!nowcast || !nowcastCoversNow(nowcast, now)) {
    return [];
  }
  const byArea = new Map<string, string>();
  for (const row of (nowcast.forecasts as { area?: string; forecast?: string }[] | undefined) ?? []) {
    byArea.set(String(row.area ?? ""), String(row.forecast ?? ""));
  }
  const towns: [string, string][] = [];
  for (const area of Object.keys(AREA_REGION)) {
    const text = byArea.get(area) ?? "";
    if (isRain(text)) {
      towns.push([area, text]);
    }
  }
  return towns;
}

// NEA has no 4-hour product: beyond the 2-hour nowcast, use the 24-hour forecast periods overlapping the window.
function periodRainRegions(
  forecast: Record<string, unknown>,
  now: Date,
  hours: number,
): Record<string, string> | null {
  const windowEnd = new Date(now.getTime() + hours * 3_600_000);
  const rainy: Record<string, string> = {};
  const periods =
    (forecast.periods as
      | { time?: { start?: string; end?: string }; regions?: Record<string, string> }[]
      | undefined) ?? [];
  for (const period of periods) {
    const start = parseSgt(period.time?.start);
    const end = parseSgt(period.time?.end);
    if (!start || !end || end <= now || start >= windowEnd) {
      continue;
    }
    for (const [region, text] of Object.entries(period.regions ?? {})) {
      if (isRain(String(text)) && !(region in rainy)) {
        rainy[region] = String(text);
      }
    }
  }
  return Object.keys(rainy).length ? rainy : null;
}

function joinNames(names: string[]): string {
  if (names.length === 1) {
    return names[0];
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function townsForRegions(regions: string[]): string[] {
  const names: string[] = [];
  for (const region of regions) {
    const town = REGION_TOWNS[region as (typeof REGION_ORDER)[number]]?.[0];
    if (town && !names.includes(town)) {
      names.push(town);
    }
  }
  return names;
}

function whereText(rainy: string[], towns: string[]): string {
  const orderedTowns = Object.keys(AREA_REGION).filter((name) => towns.includes(name));
  let orderedRegions = REGION_ORDER.filter((name) => rainy.includes(name));
  if (orderedTowns.length) {
    if (orderedTowns.length <= MAX_NAMED_TOWNS) {
      return joinNames(orderedTowns);
    }
    if (!orderedRegions.length) {
      orderedRegions = REGION_ORDER.filter((region) =>
        orderedTowns.some((name) => AREA_REGION[name] === region),
      );
    }
    const collapsed = townsForRegions([...orderedRegions]);
    return collapsed.length ? joinNames(collapsed) : "many areas";
  }
  if (orderedRegions.length) {
    return joinNames(townsForRegions([...orderedRegions]));
  }
  return "";
}

function areaClause(rainy: string[], towns: string[]): string {
  const where = whereText(rainy, towns);
  return where ? ` over ${where}` : "";
}

function rainChance(
  conditions: string,
  rainyRegions: Record<string, string>,
  towns: [string, string][],
): number {
  if (conditions.toLowerCase().includes("thunder")) {
    return RAIN_CHANCE_THUNDER;
  }
  if (Object.keys(rainyRegions).length >= WIDE_RAIN_REGIONS || towns.length >= WIDE_RAIN_TOWNS) {
    return RAIN_CHANCE_WIDE;
  }
  return RAIN_CHANCE_SOME;
}

export function pm25Band(high: number): string {
  if (high <= PM25_NORMAL_MAX) {
    return "Normal";
  }
  if (high <= PM25_ELEVATED_MAX) {
    return "Elevated";
  }
  if (high <= PM25_HIGH_MAX) {
    return "High";
  }
  return "Very High";
}

export function measuredPm25Band(pm25: Record<string, unknown> | null | undefined): string | null {
  const range = pm25Range(pm25);
  return range ? pm25Band(range.high) : null;
}

export function pm25BandFromItem(pm25: Record<string, unknown> | null | undefined): string {
  return measuredPm25Band(pm25) ?? "Normal";
}

function pm25Range(pm25: Record<string, unknown> | null | undefined): { low: number; high: number } | null {
  if (!pm25) {
    return null;
  }
  const readings = pm25.readings && typeof pm25.readings === "object" ? (pm25.readings as Record<string, unknown>) : {};
  const regional = readings.pm25_one_hourly;
  if (!regional || typeof regional !== "object") {
    return null;
  }
  const values: number[] = [];
  for (const region of REGION_ORDER) {
    const raw = (regional as Record<string, unknown>)[region];
    if (raw === undefined || raw === null) {
      continue;
    }
    const parsed = intField(raw, Number.NaN);
    if (Number.isNaN(parsed)) {
      continue;
    }
    values.push(parsed);
  }
  if (!values.length) {
    return null;
  }
  return { low: Math.min(...values), high: Math.max(...values) };
}

export function shouldSendWeather(hour: number): boolean {
  return hour >= WEATHER_DAY_START_HOUR && hour <= WEATHER_DAY_END_HOUR;
}

function windowHours(raining: boolean, band: string): number {
  return raining || band !== "Normal" ? NOWCAST_HOURS : ROUTINE_HOURS;
}

function hourWindow(hours: number): string {
  return `next ${hours} hours`;
}

function pm25Activity(band: string): string {
  if (band === "Elevated") {
    return "Elevated: reduce strenuous outdoor activity";
  }
  if (band === "High") {
    return "High: avoid strenuous outdoor activity";
  }
  if (band === "Very High") {
    return "Very High: minimise all outdoor activity";
  }
  return band;
}

export function renderPm25Clause(pm25: Record<string, unknown> | null | undefined): string {
  const range = pm25Range(pm25);
  if (!range) {
    return "";
  }
  const label = pm25Activity(pm25Band(range.high));
  if (range.low === range.high) {
    return `, PM2.5 ${range.high} (${label})`;
  }
  return `, PM2.5 ${range.low}-${range.high} (${label})`;
}

function dryConditions(
  forecast: Record<string, unknown>,
  nowcast: Record<string, unknown> | null | undefined,
): string {
  const texts = ((nowcast?.forecasts as { forecast?: string }[] | undefined) ?? [])
    .map((row) => String(row.forecast ?? ""))
    .filter((text) => text.trim() && !isRain(text));
  if (texts.length) {
    return pickConditions(texts);
  }
  const general = (forecast.general as { forecast?: string } | undefined)?.forecast ?? "Fair";
  const cleaned = cleanConditions(String(general));
  return isRain(cleaned) ? "Fair" : cleaned;
}

export function conditionIcon(condition: string, sgtHour: number): string {
  const lower = condition.toLowerCase();
  if (lower.includes("thunder")) return "⛈️";
  if (lower.includes("shower") || lower.includes("rain") || lower.includes("drizzle")) return "🌧️";
  if (lower.includes("haz") || lower.includes("mist")) return "🌫️";
  if (lower.includes("wind")) return "💨";
  if (lower.includes("partly cloudy")) return "⛅";
  if (lower.includes("cloudy") || lower.includes("overcast")) return "☁️";
  if (lower.includes("fair") || lower.includes("sunny")) return sgtHour >= 7 && sgtHour < 19 ? "☀️" : "🌙";
  return "🌤️";
}

export function renderWeatherBullet(
  forecast: Record<string, unknown>,
  nowcast: Record<string, unknown> | null | undefined,
  now: Date,
  aheadHours = NOWCAST_HOURS,
): string {
  const general = (forecast.general as {
    temperature?: { high?: number; low?: number };
  } | undefined) ?? {};
  const high = intField(general.temperature?.high, 0);
  const low = intField(general.temperature?.low, 0);
  const window = hourWindow(aheadHours);
  const towns = nowcastRainTowns(nowcast, now);
  if (towns.length) {
    const conditions = pickConditions(towns.map(([, text]) => text));
    const areas = areaClause([], towns.map(([area]) => area));
    const chance = rainChance(conditions, {}, towns);
    return `${conditions} in ${window} (${chance}% chance)${areas}, ${low}°C-${high}°C`;
  }
  const periodRain = aheadHours > NOWCAST_HOURS ? periodRainRegions(forecast, now, aheadHours) : null;
  if (periodRain) {
    const conditions = pickConditions(Object.values(periodRain));
    const chance = rainChance(conditions, periodRain, []);
    return `${conditions} in ${window} (${chance}% chance)${areaClause(Object.keys(periodRain), [])}, ${low}°C-${high}°C`;
  }
  const conditions = dryConditions(forecast, nowcastCoversNow(nowcast, now) ? nowcast : null);
  return `${conditions} in ${window} (no rain), ${low}°C-${high}°C`;
}

function formatCronWeatherDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SGT,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  let month = parts.find((part) => part.type === "month")?.value ?? "";
  if (month.endsWith(".")) {
    month = month.slice(0, -1);
  }
  if (month === "Sept") {
    month = "Sep";
  }
  return `${weekday} ${day} ${month}`;
}

export async function formatWeatherMessage(
  options: {
    now?: Date;
    forecast?: Record<string, unknown>;
    nowcast?: Record<string, unknown> | null;
    pm25?: Record<string, unknown> | null;
    cronLayout?: boolean;
  } = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const live = options.forecast === undefined;
  const forecast = options.forecast ?? (await fetchJson(FORECAST_24H, now));
  const nowcast =
    options.nowcast !== undefined ? options.nowcast : await fetchJson(FORECAST_2H, now);
  let pm25 = options.pm25;
  if (pm25 === undefined && live) {
    try {
      pm25 = await fetchPm25Item();
    } catch {
      pm25 = null;
    }
  }
  const raining = nowcastHasRain(nowcast, now);
  const band = pm25BandFromItem(pm25);
  const aheadHours = windowHours(raining, band);
  const bullet = renderWeatherBullet(forecast, nowcast, now, aheadHours);
  const clause = renderPm25Clause(pm25);

  const parts = sgtParts(now);
  const title = `Singapore Weather ${formatCronWeatherDate(now)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
  if (options.cronLayout) {
    const conditionMatch = bullet.match(/^[A-Za-z\s]+/);
    const condition = conditionMatch?.[0] ?? "Fair";
    const icon = conditionIcon(condition, sgtHour(now));
    return `${title}\n\n${icon} ${bullet}${clause}`;
  }

  const header = `🌤️ ${title}`;
  return `${header}\n${bullet}${clause}`;
}

const WEATHER_BLOCK = /^🌤️[^\n]*(?:\n(?!📅|📋|🌍|💻|🇸🇬|🌤️).*)*/m;

export function replaceWeatherSection(text: string, weather: string): string {
  const next = weather.trim();
  if (WEATHER_BLOCK.test(text)) {
    return text.replace(WEATHER_BLOCK, next).trim();
  }
  return `${text.trimEnd()}\n\n${next}`;
}
