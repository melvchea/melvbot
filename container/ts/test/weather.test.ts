import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  publishReplacingMessage,
  readWeatherMessageRef,
  deleteQuotedStaleWeather,
} from "../src/telegram/weather_message.js";

import { shouldSendWeather } from "../src/telegram/weather.js";
import { tempDir } from "./helpers/temp.js";

test("hourly weather posts only for rain or non-normal PM2.5, plus the all-clear", () => {
  assert.equal(shouldSendWeather(11, "Normal"), false);
  assert.equal(shouldSendWeather(11, "Normal", null, true), true);
  assert.equal(shouldSendWeather(11, "Elevated"), true);
  assert.equal(shouldSendWeather(11, "Normal", "Elevated"), true);
  assert.equal(shouldSendWeather(22, "Elevated"), false);
});
