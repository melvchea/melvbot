import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  replacePriorMessages,
} from "../src/telegram/weather_message.js";

import { renderWeatherBullet, shouldSendWeather } from "../src/telegram/weather.js";
import { tempDir } from "./helpers/temp.js";

test("morning update deletes every message of the prior run and records the new ones", async () => {
  const file = path.join(tempDir("morning-"), "morning-messages.json");
  const deleted: number[] = [];
  const api = {
    deleteMessage: async (_chat: number, id: number) => {
      deleted.push(id);
    },
  };
  await replacePriorMessages(api, 1, [10, 11, 12], file);
  assert.deepEqual(deleted, []);
  await replacePriorMessages(api, 1, [20, 21], file);
  assert.deepEqual(deleted, [10, 11, 12]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { chatId: 1, messageIds: [20, 21] });
});

test("hourly weather posts every hour 06:00-22:00 SGT regardless of rain or PM2.5", () => {
  assert.equal(shouldSendWeather(6), true);
  assert.equal(shouldSendWeather(11), true);
  assert.equal(shouldSendWeather(22), true);
  assert.equal(shouldSendWeather(5), false);
  assert.equal(shouldSendWeather(23), false);
});

test("4-hour window uses 24h forecast periods overlapping now..now+4h", () => {
  const now = new Date("2026-10-25T12:00:00+08:00");
  const period = (start: string, end: string, text: string) => ({
    time: { start: `2026-10-25T${start}:00+08:00`, end: `2026-10-25T${end}:00+08:00` },
    regions: { central: text, east: text, north: text, south: text, west: text },
  });
  const general = { temperature: { high: 33, low: 24 }, forecast: "Fair" };
  const wet = { general, periods: [period("10:00", "14:00", "Thundery Showers")] };
  const later = { general, periods: [period("17:00", "23:00", "Thundery Showers")] };
  assert.match(renderWeatherBullet(wet, null, now, 4), /^Thundery Showers in next 4 hours \(\d+% chance\)/);
  assert.match(renderWeatherBullet(later, null, now, 4), /\(no rain\)/);
});
