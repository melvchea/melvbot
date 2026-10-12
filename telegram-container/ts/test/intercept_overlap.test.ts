import assert from "node:assert/strict";
import test from "node:test";
import { matchAgendaProse } from "../src/telegram/agenda_prose.js";
import { matchImagegenProse } from "../src/telegram/imagegen_prose.js";
import { matchOcrProse } from "../src/telegram/ocr_prose.js";
import { matchRemindersProse } from "../src/telegram/reminders_prose.js";
import { matchVideogenProse } from "../src/telegram/videogen_prose.js";
import { matchWeatherProse } from "../src/telegram/weather_prose.js";
import { soleNonemptyLineStripped } from "../src/telegram/prose_line.js";
import { dateReply, matchDateProse } from "../src/telegram/date_prose.js";
import { wouldDispatchProseIntercept } from "../src/telegram/prose_intercept.js";

/** Names of every instant matcher that accepts the message. */
function handlers(text: string): string[] {
  const hits: string[] = [];
  if (matchOcrProse(text)) hits.push("ocr");
  if (matchWeatherProse(text) !== null) hits.push("weather");
  if (matchAgendaProse(text) !== null) hits.push("agenda");
  if (matchRemindersProse(text)) hits.push("reminders");
  if (matchImagegenProse(text) !== null) hits.push("imagegen");
  if (matchVideogenProse(text) !== null) hits.push("videogen");
  return hits;
}

const TABLE: [string, string | null][] = [
  ["weather", "weather"],
  ["  Weather please?! ", "weather"],
  ["what's the weather 🌧️", "weather"],
  ["calendar", "agenda"],
  ["What's on my calendar tomorrow?", "agenda"],
  ["tasks", "agenda"],
  ["reminders", "reminders"],
  ["what reminders do I have?", "reminders"],
  ["reminders for tomorrow?", null],
  ["make a video of my calendar", "videogen"],
  ["make an image of the weather", "imagegen"],
  ["ocr this", "ocr"],
  ["ocr", "ocr"],
  ["how do I make a video of my cat?", null],
  ["can you explain the weather in Tokyo?", null],
  ["rename note x to tasks", null],
  ["is there a calendar for next month?", null],
  ["undo", null],
  ["undo that", null],
  ["undo last change", null],
];

test("each table message is claimed by exactly the expected handler", () => {
  for (const [message, expected] of TABLE) {
    assert.deepEqual(handlers(message), expected ? [expected] : [], JSON.stringify(message));
  }
});

test("polite filler and word order do not defeat an intercept; explain-style questions still reach Claude", async () => {
  assert.equal(matchWeatherProse("what's the weather in Singapore today?") !== null, true);
  for (const text of ["hey, can you show tasks please", "please undo", "could you ocr this", "list notes pls", "weather in sg now"]) {
    assert.equal(await wouldDispatchProseIntercept(text), true, text);
  }
  for (const text of ["can you explain the weather in Tokyo?", "please", "hey there", "thanks"]) {
    assert.equal(await wouldDispatchProseIntercept(text), false, text);
  }
});

test("date prose answers today/tomorrow/yesterday queries in Singapore time; other text is not claimed", () => {
  assert.equal(matchDateProse("what is tmrw's date"), 1);
  assert.equal(matchDateProse("What's today's date?"), 0);
  assert.equal(matchDateProse("what day is tomorrow"), 1);
  assert.equal(matchDateProse("what day was yesterday?"), -1);
  assert.equal(matchDateProse("what day is my flight"), null);
  assert.equal(matchDateProse("what is the date of the next payday"), null);
  const now = new Date("2026-10-06T17:00:00Z"); // 7 Oct 01:00 in Singapore
  assert.equal(dateReply(0, now), "Wednesday, 7 Oct 2026");
  assert.equal(dateReply(1, now), "Thursday, 8 Oct 2026");
});
