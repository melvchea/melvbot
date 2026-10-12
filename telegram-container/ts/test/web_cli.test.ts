import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage } from "../src/assistant/fallback.js";
import { askMessages, extractMessages, runWebCli, type WebCliDeps } from "../src/web/cli.js";
import { digestMessages, runDigestCli, type DigestDeps } from "../src/web/digest.js";

const HITS = [
  { title: "A", url: "https://a.com/1", snippet: "snippet a" },
  { title: "A2", url: "https://a.com/2", snippet: "snippet a2" },
  { title: "B", url: "https://b.com/x", snippet: "snippet b" },
  { title: "C", url: "https://c.com/y", snippet: "snippet c" },
];

function harness(over: Partial<WebCliDeps> = {}) {
  const out: string[] = [];
  const completions: { messages: ChatMessage[]; maxTokens: number }[] = [];
  const fetched: string[] = [];
  const deps: WebCliDeps = {
    write: (text) => void out.push(text),
    search: async (query) => ({ query, results: HITS }),
    fetchPage: async (url) => {
      fetched.push(url);
      return { url, contentType: "text/html", text: `page text for ${url}` };
    },
    complete: async (messages, maxTokens) => {
      completions.push({ messages, maxTokens });
      return { text: "the digest", provider: "groq" };
    },
    ...over,
  };
  return { deps, out, completions, fetched };
}

test("extract sends the page to the cheap model and prints only the digest and source; ask falls back to a snippet when a page fails, and fails cleanly with no readable source", async () => {
  const { deps, out, completions } = harness();
  assert.equal(await runWebCli(["extract", "https://a.com/1", "what", "is", "the", "price", "--words", "50"], deps), 0);
  assert.equal(out[0], "the digest\n\nSource: https://a.com/1\n");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].maxTokens, 200);
  const [system, user] = completions[0].messages;
  assert.match(system.content, /untrusted data/);
  assert.match(system.content, /At most 50 words/);
  assert.match(user.content, /Question: what is the price/);
  assert.match(user.content, /page text for https:\/\/a\.com\/1/);
  {
    const flaky = harness({
      fetchPage: async (url) => {
        if (url.includes("b.com")) {
          throw new Error("blocked");
        }
        return { url, contentType: "text/html", text: "ok page" };
      },
    });
    assert.equal(await runWebCli(["ask", "q"], flaky.deps), 0);
    assert.equal(flaky.completions.length, 0, "sources under the short-page size skip the digest model call");
    assert.match(flaky.out[0], /\[2\] https:\/\/b\.com\/x\n<page>\nsnippet b\n<\/page>/);

    const none = harness({ search: async (query) => ({ query, results: [] }) });
    assert.equal(await runWebCli(["ask", "q"], none.deps), 1);
    assert.equal(none.out[0], "No readable sources found.\n");
    assert.equal(none.completions.length, 0);
  }
});

function digestHarness(over: Partial<DigestDeps> = {}) {
  const out: string[] = [];
  const calls: { messages: ChatMessage[]; maxTokens: number }[] = [];
  const deps: DigestDeps = {
    write: (text) => void out.push(text),
    readStdin: async () => "line one\nERROR: boom at src/a.ts:12\n",
    complete: async (messages, maxTokens) => {
      calls.push({ messages, maxTokens });
      return { text: "the digest", provider: "groq" };
    },
    topNotes: () => [{ slug: "phone-buy", title: "Phones", body: "Pixel 11 Pro is the pick." }],
    ...over,
  };
  return { deps, out, calls };
}
