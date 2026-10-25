import assert from "node:assert/strict";
import { test } from "node:test";

import { selectHeadlines, type Headline } from "../src/cron/news.js";

const NOW = new Date("2026-10-11T00:00:00Z");
const headline = (title: string, url: string): Headline => ({
  title,
  url,
  published: new Date("2026-10-10T20:00:00Z"),
  source: "BBC",
});

test("selectHeadlines drops near-duplicate stories and lets the next headline fill the slot", () => {
  const picked = selectHeadlines(
    [
      headline("'Time for Ukraine to get new president,' says Trump after Zelensky condemns diesel deal", "https://a/1"),
      headline("Watch: 'Time for Ukraine to get a new president', says Trump", "https://a/2"),
      headline("Expedition hopes to find Amelia Earhart's plane on remote island", "https://a/3"),
      headline("Expedition hopes to find Amelia Earhart's plane on remote island", "https://a/4"),
    ],
    [],
    NOW,
  );
  assert.deepEqual(picked.map((item) => item.url), ["https://a/1", "https://a/3"]);
});
