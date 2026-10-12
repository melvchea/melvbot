import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { KagiBreaker, parseKagiResults } from "../../src/assistant/providers/kagi_search.js";

const fixture = readFileSync(new URL("../fixtures/kagi_results.html", import.meta.url), "utf8");

test("Kagi HTML results parse to title, URL, snippet and date; Kagi-internal and duplicate links dropped", () => {
  const hits = parseKagiResults(fixture, 20);
  assert.ok(hits.length >= 7, `hits=${hits.length}`);
  assert.equal(hits[0].title, "Paris - Wikipedia");
  assert.equal(hits[0].url, "https://en.wikipedia.org/wiki/Paris");
  assert.match(hits[0].snippet, /capital of France/);
  const urls = new Set<string>();
  for (const h of hits) {
    assert.ok(h.title && h.url && h.snippet, `bad hit ${JSON.stringify(h)}`);
    assert.doesNotMatch(h.url, /^https?:\/\/([^/]*\.)?kagi\.com/);
    assert.doesNotMatch(h.snippet, /Summarize/);
    assert.ok(!urls.has(h.url), `duplicate ${h.url}`);
    urls.add(h.url);
    assert.ok(h.date === undefined || /^\d{4}-\d{2}-\d{2}$/.test(h.date), `date ${h.date}`);
  }
  assert.equal(
    hits.find((h) => new URL(h.url).hostname.split(".").slice(-2).join(".") === "reddit.com")?.date,
    "2021-10-03",
  );
  assert.equal(parseKagiResults(fixture, 3).length, 3);
});

test("breaker opens after 3 failed or empty searches, then lets one probe through after the cooldown", () => {
  const breaker = new KagiBreaker(3, 1000);
  breaker.record(false, 0);
  breaker.record(true, 0);
  breaker.record(false, 0);
  breaker.record(false, 0);
  assert.equal(breaker.allowed(0), true, "a success resets the count");
  breaker.record(false, 10);
  assert.equal(breaker.allowed(500), false);
  assert.equal(breaker.allowed(1010), true);
  breaker.record(false, 1010);
  assert.equal(breaker.allowed(1011), false, "a failed probe reopens for a full cooldown");
  breaker.record(true, 3000);
  assert.equal(breaker.allowed(3001), true);
});
