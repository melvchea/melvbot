import { soleNonemptyLineStripped } from "./prose_line.js";
import { sgtHour } from "./weather.js";

const AFTERNOON_FROM_HOUR = 13;
const WEATHER_WINDOWS = new Set(["morning", "afternoon"]);
const WEATHER_PROSE_RE =
  /^(?:(?:what(?:'s|s| is)|how(?:'s|s| is)) (?:the )?)?(?:(?:sg|singapore) )?(?:(?<pre>morning|afternoon) )?weather(?: in (?:sg|singapore))?(?: (?<post>morning|afternoon|please|now|today))?(?: in (?:sg|singapore))?$/;

export type WeatherWindow = "morning" | "afternoon";

export function matchWeatherProse(text: string, now = new Date()): WeatherWindow | null {
  const line = soleNonemptyLineStripped(text);
  if (line === null) {
    return null;
  }
  const matched = WEATHER_PROSE_RE.exec(line.toLowerCase());
  if (matched === null) {
    return null;
  }
  const named = matched.groups?.pre || matched.groups?.post;
  if (named && WEATHER_WINDOWS.has(named)) {
    return named as WeatherWindow;
  }
  return sgtHour(now) >= AFTERNOON_FROM_HOUR ? "afternoon" : "morning";
}
