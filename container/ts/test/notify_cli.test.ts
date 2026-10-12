import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { runNotifyCli } from "../src/telegram/notify_cli.js";

const NOW = new Date("2026-10-12T06:05:00Z");

test("notify sends a titled message to the owner chat; without a token it refuses and sends nothing", async () => {
  process.env.MELVBOT_TS_ALLOW_LIVE_TOKEN = "1";
  process.env.TELEGRAM_CHAT_ID = "42";
  const calls: { url: string; body: string }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: { body: unknown }) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  try {
    delete process.env.MELVBOT__TRANSPORTS__TELEGRAM__BOT_TOKEN;
    assert.equal(await runNotifyCli(["Deploy OK", "abc1234"], NOW), 2);
    assert.equal(calls.length, 0);

    process.env.MELVBOT__TRANSPORTS__TELEGRAM__BOT_TOKEN = "tok";
    assert.equal(await runNotifyCli(["Deploy OK", "abc1234"], NOW), 0);
    assert.match(calls[0].url, /\/bottok\/sendMessage$/);
    const sent = JSON.parse(calls[0].body) as { chat_id: number; text: string };
    assert.equal(sent.chat_id, 42);
    assert.equal(sent.text, "Deploy OK Mon 12 Oct 14:05\n\nabc1234");
  } finally {
    mock.restoreAll();
  }
});
