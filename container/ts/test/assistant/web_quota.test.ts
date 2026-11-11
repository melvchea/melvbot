import assert from "node:assert/strict";
import { test } from "node:test";

import { tempDbPath } from "../helpers/temp.js";

process.env.MELVBOT_ASSISTANT_CONVERSATION_DB = tempDbPath();

import { getWebQuota } from "../../src/assistant/conversation_store.js";
import { ProviderHttpError } from "../../src/assistant/providers/http_error.js";
import { sgtMonth, webQuotaOk, withWebQuota } from "../../src/assistant/web_quota.js";

const NOW = new Date("2026-11-11T00:00:00.000Z");
const rowFor = (provider: string) => getWebQuota(sgtMonth(NOW)).find((r) => r.provider === provider);

test("withWebQuota counts only successful calls, so failed fetches do not burn credits", async () => {
  await withWebQuota("brightdata", async () => "ok", NOW);
  await assert.rejects(withWebQuota("brightdata", async () => { throw new Error("timeout"); }, NOW), /timeout/);
  assert.equal(rowFor("brightdata")?.calls, 1);
  assert.equal(webQuotaOk("brightdata", NOW), true);
});

test("withWebQuota marks the provider exhausted on 402/429 and then refuses calls", async () => {
  await assert.rejects(withWebQuota("firecrawl", async () => { throw new ProviderHttpError(402, "credits"); }, NOW));
  assert.equal(rowFor("firecrawl")?.exhausted, true);
  await assert.rejects(withWebQuota("firecrawl", async () => "never", NOW), /monthly quota used/);
});
