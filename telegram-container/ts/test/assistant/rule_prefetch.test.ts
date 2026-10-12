import assert from "node:assert/strict";
import { test } from "node:test";

import { dcaNoteBlock, fetchYahooQuote, fetchYahooQuotes, prefetchRule } from "../../src/assistant/rule_prefetch.js";

test("DCA note block carries revision_id so the cron's full-body write can pass --expect-rev", () => {
  assert.match(dcaNoteBlock({ body: "Plan", revision_id: "rev42" }), /^<untrusted source="note">\n<note slug="dollar-cost-averaging" revision_id="rev42">\nPlan\n<\/note>\n<\/untrusted>$/);
});

test("prefetchRule injects the rule body and tolerates failing data fetches", async () => {
  const trigger = { rule: "demo", match: /^demo$/, data: [async () => "<untrusted>x</untrusted>", async () => { throw new Error("boom"); }] };
  const got = await prefetchRule("demo", { triggers: [trigger], loadRuleBody: () => "BODY" });
  assert.ok(got);
  assert.match(got.block, /<rule name="demo">\nBODY\n<\/rule>/);
  assert.match(got.block, /<untrusted>x<\/untrusted>/);
  assert.equal(await prefetchRule("other", { triggers: [trigger], loadRuleBody: () => "BODY" }), null);
  assert.equal(await prefetchRule("demo", { triggers: [trigger], loadRuleBody: () => null }), null);
});

const chartFixture = (closes: (number | null)[]) => ({
  chart: { result: [{ timestamp: [1790000000, 1790086400, 1790172800].slice(0, closes.length), indicators: { quote: [{ close: closes }] } }] },
});

test("fetchYahooQuotes wraps as untrusted, skips failed symbols, null when all fail", async () => {
  const ok = (async (url: RequestInfo | URL) =>
    String(url).includes("%5EDJI")
      ? ({ ok: false, json: async () => ({}) } as Response)
      : ({ ok: true, json: async () => chartFixture([100, 101]) } as Response)) as typeof fetch;
  const got = await fetchYahooQuotes(["^GSPC", "^DJI"], ok);
  assert.ok(got?.startsWith('<untrusted source="yahoo_finance">'));
  assert.match(got, /S&P 500/);
  assert.doesNotMatch(got, /Dow/);
  const bad = (async () => {
    throw new Error("down");
  }) as typeof fetch;
  assert.equal(await fetchYahooQuotes(["^GSPC"], bad), null);
});

// Regression: Yahoo 429s full Chrome UA strings, so the DCA Bonds bullet silently fell back to model text.