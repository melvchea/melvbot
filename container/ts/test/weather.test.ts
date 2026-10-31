import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  replacePriorMessages,
} from "../src/telegram/weather_message.js";

import { renderWeatherBullet, renderWindClause, shouldSendWeather } from "../src/telegram/weather.js";
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

test("4-hour window takes hours 2-4 rain from the hourly outlook", () => {
  const now = new Date("2026-10-25T12:00:00+08:00");
  const t0 = now.getTime() / 1000;
  const outlook = (hour: number, code: number, prob: number) => {
    const time = [0, 1, 2, 3, 4, 5].map((h) => t0 + h * 3600);
    const codes = time.map((_, h) => (h === hour ? code : 3));
    const probs = time.map((_, h) => (h === hour ? prob : 0));
    return { time, weather_code: codes, precipitation_probability: probs };
  };
  const forecast = { general: { temperature: { high: 33, low: 24 }, forecast: "Fair" } };
  const bullet = (hour: number, code: number, prob: number) =>
    renderWeatherBullet(forecast, null, now, 4, outlook(hour, code, prob));
  assert.equal(bullet(3, 95, 70), "Thundery Showers in next 4 hours (70% chance), 24°C-33°C");
  assert.match(bullet(2, 80, 55), /^Showers in next 4 hours \(55% chance\)/);
  assert.match(bullet(0, 95, 90), /\(no rain\)/);
  assert.match(bullet(5, 95, 90), /\(no rain\)/);
  assert.match(bullet(3, 80, 30), /\(no rain\)/);
});

test("wind clause uses circular mean so 350° and 10° average to N", () => {
  assert.equal(renderWindClause([350, 10, 0]), ", Wind N");
  assert.equal(renderWindClause([100, 106, 139]), ", Wind SE");
  assert.equal(renderWindClause([]), "");
});
