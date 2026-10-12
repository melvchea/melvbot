import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { BRAVE_SEARCH_ENV_KEY } from "../../src/assistant/providers/brave_search.js";
import { BRIGHTDATA_ENV_KEY, BRIGHTDATA_ZONE_ENV_KEY } from "../../src/assistant/providers/brightdata.js";
import { FIRECRAWL_ENV_KEY } from "../../src/assistant/providers/firecrawl.js";
import {
  clearWebCaches,
  isAllowedCliCall,
  toolReadRule,
  webFetch,
  webFetchMany,
  isHostileHost,
  deprioritiseHostile,
  webSearch,
  webSearchMany,
  webSearchRead,
  FETCH_BLOCKED_DOMAINS,
} from "../../src/assistant/tools.js";
import { setHostLookupForTests } from "../../src/assistant/net_guard.js";
import { loadPromptCatalog } from "../../src/assistant/prompt_files.js";
import { jsonResponse, withFetch, stubFetch } from "../helpers/fetch.js";
import { tempDir, tempDbPath } from "../helpers/temp.js";
import { writePrompt } from "../helpers/prompts.js";
import { lookup } from "node:dns/promises";

// Bug: Brave usage was read from the real DB, so the fallback test failed once the month's quota was used.
// Each test gets a fresh DB so provider counts, exhaustion and the page cache never leak between tests.
function freshDb(): void {
  process.env.MELVBOT_ASSISTANT_CONVERSATION_DB = tempDbPath("conv.sqlite3");
}
beforeEach(() => {
  freshDb();
  clearWebCaches();
});
// Bug: example.com was resolved via real DNS, so fetch tests failed offline (sandboxed dverify blocked ddeploy).
// Unlisted hosts throw instead of falling through to real DNS.
setHostLookupForTests((async (host: string) => {
  if (host === "example.com" || host.endsWith(".example")) {
    return [{ address: "93.184.215.14", family: 4 }];
  }
  throw new Error(`unmocked DNS lookup: ${host}`);
}) as typeof lookup);

test("CLI and rule-file allowlists reject anything outside them", () => {
  assert.equal(isAllowedCliCall(["sheet", "rules"]), true);
  assert.equal(isAllowedCliCall(["note", "get"]), true);
  assert.equal(isAllowedCliCall(["note", "append-history"]), true);
  assert.equal(isAllowedCliCall(["note", "rename"]), true);
  assert.equal(isAllowedCliCall(["sheet", "rename"]), true);
  assert.equal(isAllowedCliCall(["cron", "delete"]), true);
  assert.equal(isAllowedCliCall(["google", "tasks"]), true);
  assert.equal(isAllowedCliCall(["outlook", "inbox"]), true);
  assert.equal(isAllowedCliCall(["config", "set"]), false);
  assert.equal(isAllowedCliCall(["docker"]), false);
  assert.equal(isAllowedCliCall(["sheet"]), false);
  assert.equal(isAllowedCliCall(["note", "raw-sql"]), false);
  const dir = tempDir("assistant-tools-prompts-");
  writePrompt(dir, "weather", "Weather rules", false, "Body");
  const catalog = loadPromptCatalog(dir);
  assert.throws(() => toolReadRule(catalog, "melvbot-release"), /unknown rule/);
  assert.throws(() => toolReadRule(catalog, "../x"), /unknown rule/);
  assert.throws(() => toolReadRule(catalog, "weather.mdc"), /unknown rule/);
  assert.equal(toolReadRule(catalog, "weather"), "Body");
});

test("fetch guards: bad schemes, private addresses, blocked hosts", async (t) => {
  await t.test("webFetch rejects file:// URLs, loopback/cloud-metadata addresses, and a redirect to a private address", async () => {
  clearWebCaches();
    await assert.rejects(() => webFetch("file:///etc/passwd"), /unsupported URL scheme/);
    await assert.rejects(() => webFetch("http://127.0.0.1/"), /private address/);
    await assert.rejects(() => webFetch("http://169.254.169.254/latest/meta-data/"), /private address/);
    const stub = stubFetch((url) => {
      if (url.href === "https://example.com/") {
        return {
          status: 302,
          headers: new Headers({ location: "http://127.0.0.1/secret" }),
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url.href}`);
    });
    try {
      await assert.rejects(() => webFetch("https://example.com/"), /private address/);
    } finally {
      stub.restore();
    }
  });
  await t.test("hostile-domain skip-list and fetch-blocked domains: web_fetch rejects blocked hosts before any provider, private hosts still rejected, hits are deprioritised only for hostile", async () => {
    assert.ok(isHostileHost("investing.com"));
    assert.ok(isHostileHost("www.WSJ.com"));
    assert.ok(!isHostileHost("notbloomberg.com"));
    await assert.rejects(() => webFetch("https://www.bloomberg.com/x"), /blocked\/paywalled — use another result/);
    const hits = [
      { title: "a", url: "https://www.ft.com/a", snippet: "" },
      { title: "b", url: "https://example.org/b", snippet: "" },
    ];
    assert.deepEqual(deprioritiseHostile(hits).map((h) => h.title), ["b", "a"]);
    clearWebCaches();
    const stub = stubFetch(() => jsonResponse(FIRECRAWL_SCRAPE_OK("Thread text")));
    const prevErr = console.error;
    console.error = () => {};
    try {
      await assert.rejects(() => webFetch("https://www.reddit.com/r/singapore/comments/abc/x/"), /blocks server fetches/);
      assert.equal(stub.calls.length, 0, "reddit should not reach any fetch provider");
      await assert.rejects(() => webFetch("http://127.0.0.1:8080/"));
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
      console.error = prevErr;
    }
    const redditHits = [
      { title: "a", url: "https://www.reddit.com/a", snippet: "reddit answer" },
      { title: "b", url: "https://example.org/b", snippet: "other answer" },
    ];
    // reddit hits are NOT deprioritised (stay in original order)
    assert.deepEqual(deprioritiseHostile(redditHits).map((h) => h.title), ["a", "b"]);
  });
});

const BRAVE_OK = { web: { results: [{ title: "Brave hit", url: "https://brave.example", description: "B" }] } };
const FIRECRAWL_SEARCH_OK = { success: true, data: { web: [{ title: "Firecrawl hit", url: "https://firecrawl.example", description: "F" }] } };
const FIRECRAWL_SCRAPE_OK = (markdown: string) => ({ success: true, data: { markdown, metadata: { title: "T" } } });

test("webFetch: Firecrawl, then Bright Data HTML, then in-process", async (t) => {
  process.env[FIRECRAWL_ENV_KEY] = "fc-key";
  process.env[BRIGHTDATA_ENV_KEY] = "bd-key";
  process.env[BRIGHTDATA_ZONE_ENV_KEY] = "zone";
  await t.test("Firecrawl markdown answers alone, with the page title as heading; a repeat read within the hour (fragment ignored) is cached", async () => {
    clearWebCaches();
    const hosts: string[] = [];
    await withFetch(
      (url) => {
        hosts.push(url.host);
        return jsonResponse(FIRECRAWL_SCRAPE_OK("Body text"));
      },
      async () => {
        assert.equal((await webFetch("https://example.com/a")).text, "# T\n\nBody text");
        assert.equal((await webFetch("https://example.com/a#top")).text, "# T\n\nBody text");
      },
    );
    assert.deepEqual(hosts, ["api.firecrawl.dev"]);
  });
  await t.test("Firecrawl quota (402) or empty markdown falls through to Bright Data, whose HTML is extracted", async () => {
    for (const firecrawl of [() => jsonResponse({ success: false }, 402), () => jsonResponse(FIRECRAWL_SCRAPE_OK(""))]) {
      freshDb();
      clearWebCaches();
      await withFetch(
        (url, init) => {
          if (url.host === "api.firecrawl.dev") {
            return firecrawl();
          }
          assert.equal(url.host, "api.brightdata.com");
          assert.equal(JSON.parse(String(init?.body)).format, "raw");
          return new Response("<p>Fallback body</p>", { headers: { "content-type": "text/html" } });
        },
        async () => {
          assert.equal((await webFetch("https://example.com/b")).text, "Fallback body");
        },
      );
    }
  });
  await t.test("when Firecrawl and Bright Data both fail, the in-process fetch answers; a PDF there is reported unsupported", async () => {
    clearWebCaches();
    await withFetch(
      (url) => {
        if (url.host === "example.com") {
          return new Response("Direct body", { headers: { "content-type": "text/plain" } });
        }
        return jsonResponse({ error: "boom" }, 500);
      },
      async () => {
        assert.equal((await webFetch("https://example.com/c")).text, "Direct body");
      },
    );
    clearWebCaches();
    await withFetch(
      (url) => (url.host === "api.firecrawl.dev" || url.host === "api.brightdata.com" ? jsonResponse({ error: "boom" }, 500) : new Response("%PDF", { headers: { "content-type": "application/pdf" } })),
      async () => {
        await assert.rejects(webFetch("https://example.com/a.pdf"), /PDF.*not supported.*search snippet/);
      },
    );
  });
});

test("webSearchMany groups queries and shows a failed one without failing the rest; throws only if all fail; webSearchRead skips a blocked top hit, fetches the next one and returns results plus a page section", async (t) => {
  process.env[BRAVE_SEARCH_ENV_KEY] = "test-key";
  process.env[FIRECRAWL_ENV_KEY] = "fc-key";
  await t.test("webSearchMany", async () => {
    clearWebCaches();
    const searchQuery = (url: URL, init?: RequestInit): string => (url.host === "api.search.brave.com" ? url.searchParams.get("q") ?? "" : String(JSON.parse(String(init?.body)).query));
    const handler = (url: URL, init?: RequestInit) => {
      const q = searchQuery(url, init);
      if (q.startsWith("bad")) {
        throw new Error("boom");
      }
      return jsonResponse({ web: { results: [{ title: `Hit for ${q}`, url: "https://ok.example/a", description: "S" }] } });
    };
    await withFetch(handler, async () => {
      const out = await webSearchMany(["good one", "bad one"]);
      assert.match(out, /^### good one\n1\. Hit for good one[\s\S]*### bad one\n\(search failed: /);
      await assert.rejects(() => webSearchMany(["bad a", "bad b"]), /bad a: .*bad b: /);
    });
  });
  await t.test("webSearchRead", async () => {
    clearWebCaches();
    const fetched: string[] = [];
    await withFetch(
      (url, init) => {
        if (url.host === "api.search.brave.com") {
          return jsonResponse({
            web: {
              results: [
                { title: "Blocked", url: "https://www.bloomberg.com/x", description: "p" },
                { title: "Open", url: "https://example.com/open", description: "o" },
                { title: "Third", url: "https://example.com/third", description: "t" },
              ],
            },
          });
        }
        fetched.push(String(JSON.parse(String(init?.body)).url ?? ""));
        return jsonResponse(FIRECRAWL_SCRAPE_OK("Page body text"));
      },
      async () => {
        const out = await webSearchRead(["topic"]);
        assert.deepEqual(fetched, ["https://example.com/open"]);
        assert.match(out, /1\. Open[\s\S]*3\. Blocked[\s\S]*## https:\/\/example\.com\/open\n[\s\S]*Page body text/);
      },
    );
  });
});
