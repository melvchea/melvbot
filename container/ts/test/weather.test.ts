import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  replacePriorMessages,
  publishReplacingMessage,
  readWeatherMessageRef,
  deleteQuotedStaleWeather,
} from "../src/telegram/weather_message.js";

import { shouldSendWeather } from "../src/telegram/weather.js";
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

test("hourly weather posts only for rain or non-normal PM2.5, plus the all-clear", () => {
  assert.equal(shouldSendWeather(11, "Normal"), false);
  assert.equal(shouldSendWeather(11, "Normal", null, true), true);
  assert.equal(shouldSendWeather(11, "Elevated"), true);
  assert.equal(shouldSendWeather(11, "Normal", "Elevated"), true);
  assert.equal(shouldSendWeather(22, "Elevated"), false);
});
