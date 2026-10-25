import assert from "node:assert/strict";
import { test } from "node:test";

import { resetBraveExhaustion, routedSearch, type RouterDeps } from "../../src/assistant/search_router.js";

const early = new Date("2026-10-02T00:00:00Z");
const kagiHit = [{ title: "k", url: "https://k.com", snippet: "k" }];
const braveHit = [{ title: "b", url: "https://b.com", snippet: "b" }];
const firecrawlHit = [{ title: "f", url: "https://f.com", snippet: "f" }];

type Calls = { kagi: number; brave: number; firecrawl: number; sent: number; exhausted: number; logs: string[] };

const fresh = (): Calls => {
  resetBraveExhaustion();
  return { kagi: 0, brave: 0, firecrawl: 0, sent: 0, exhausted: 0, logs: [] };
};

function deps(over: Partial<RouterDeps>, c: Calls): RouterDeps {
  return {
    kagi: async () => {
      c.kagi += 1;
      return kagiHit;
    },
    kagiAvailable: () => false,
    brave: async () => {
      c.brave += 1;
      return braveHit;
    },
    firecrawl: async () => {
      c.firecrawl += 1;
      return firecrawlHit;
    },
    braveEnabled: () => true,
    firecrawlEnabled: () => true,
    firecrawlQuotaOk: () => true,
    providers: () => ["kagi", "brave", "firecrawl"],
    now: () => early,
    usedThisMonth: () => 0,
    onBraveSent: () => {
      c.sent += 1;
    },
    onBraveExhausted: () => {
      c.exhausted += 1;
    },
    log: (line) => c.logs.push(line),
    ...over,
  };
}

test("Kagi fails, Brave answers, Brave fails, Firecrawl answers", async () => {
  const c = fresh();
  const kagi = async () => Promise.reject(new Error("kagi HTTP 500"));
  const brave = async () => Promise.reject(new Error("brave 503"));
  const r = await routedSearch("q", 8, "interactive", deps({ kagiAvailable: () => true, kagi, brave }, c));
  assert.equal(r.route, "firecrawl");
  assert.deepEqual(r.hits, firecrawlHit);
  assert.equal(c.firecrawl, 1);
  const again = fresh();
  const kagiOk = await routedSearch("q", 8, "interactive", deps({ kagiAvailable: () => true }, again));
  assert.equal(kagiOk.route, "kagi");
  assert.equal(again.brave, 0, "Kagi answers first, Brave not called");
});

test("Brave over quota is skipped without a request; Firecrawl answers; Firecrawl over quota is skipped too", async () => {
  const c = fresh();
  const r = await routedSearch("q", 8, "interactive", deps({ usedThisMonth: () => 1000 }, c));
  assert.equal(r.route, "firecrawl");
  assert.equal(c.sent, 0);
  assert.equal(c.brave, 0);
  const none = fresh();
  const skipped = await routedSearch("q", 8, "interactive", deps({ usedThisMonth: () => 1000, firecrawlQuotaOk: () => false }, none));
  assert.deepEqual(skipped.hits, []);
  assert.equal(none.firecrawl, 0);
});
