import assert from "node:assert/strict";
import { test } from "node:test";

import { runSearchCli } from "../src/assistant/search_cli.js";

test("search limits providers to kagi,brave and prints hits; empty input exits 2 without calling", async () => {
  const seen: string[] = [];
  const deps = {
    search: async (q: string) => {
      seen.push(`${q}|${process.env.SEARCH_PROVIDERS}`);
      return { query: q, results: [{ title: "T", url: "https://example.com", snippet: "S" }] };
    },
    fetchMany: async () => "page",
  };
  assert.equal(await runSearchCli("search", ["  "], deps), 2);
  assert.equal(await runSearchCli("fetch", [], deps), 2);
  assert.equal(seen.length, 0);
  assert.equal(await runSearchCli("search", ["node", "lts"], deps), 0);
  assert.deepEqual(seen, ["node lts|kagi,brave"]);
});

test("a failing provider returns exit 1", async () => {
  const deps = {
    search: async () => {
      throw new Error("boom");
    },
    fetchMany: async () => {
      throw new Error("boom");
    },
  };
  assert.equal(await runSearchCli("search", ["q"], deps), 1);
  assert.equal(await runSearchCli("fetch", ["https://example.com"], deps), 1);
});
