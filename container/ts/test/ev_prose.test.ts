import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { parseEvAddDirective, parseEvShowDirective } from "../src/sheet/ev_prose.js";
import { dispatchProseIntercept } from "../src/telegram/prose_intercept.js";
import { handleProseCallback } from "../src/telegram/prose_callback_handler.js";

const NOW = new Date("2026-10-05T04:00:00Z");

test("ev add parses odometer, kWh, date and optional cost; unusable input is not claimed", () => {
  assert.deepEqual(parseEvAddDirective("store ev charge today 23523km 64.84kWh", NOW), {
    chargedOn: "2026-10-05",
    odometerKm: 23523,
    energyKwh: "64.84",
  });
  assert.deepEqual(parseEvAddDirective("log ev charge 3 Oct 64.84 kWh $20.5", NOW), { chargedOn: "2026-10-03", energyKwh: "64.84", cost: "20.5" });
  assert.equal(parseEvAddDirective("store ev full charge today 23837km 61.64kWh", NOW)?.energyKwh, "61.64");
  assert.equal(parseEvAddDirective("store ev charge today 23523km", NOW), null);
  assert.equal(parseEvAddDirective("store ev charge today 23523km 64.84kWh and a coffee", NOW), null);
  assert.equal(parseEvAddDirective("store ev charge 31 Feb 64kWh", NOW), null);
});

test("ev add with a bad date is not written", async () => {
  const sent: { text: string }[] = [];
  const written: string[][] = [];
  const api = { sendMessage: async (_c: number, text: string) => void sent.push({ text }), editMessageText: async () => null, answerCallback: async () => undefined };
  const evAdd = {
    preview: async () => ({ needsConfirm: false, summary: "" }),
    run: async (argv: string[]) => (written.push(argv), JSON.stringify({ inserted: true })),
  };
  const handled = await dispatchProseIntercept(api as never, { message_id: 1, chat: { id: 42 }, from: { id: 7 } } as never, "store ev charge 31 Feb 64kWh", { evAdd });
  assert.equal(handled, false);
  assert.equal(written.length, 0);
  assert.equal(sent.length, 0);
});

test("ev add intercept writes via the CLI; a confirm offer writes only on Confirm", async () => {
  type Sent = { text: string; extra?: { reply_markup?: { inline_keyboard: { callback_data: string }[][] } } };
  const written: string[][] = [];
  const evAdd = {
    preview: async () => ({ needsConfirm: true, summary: "Log?\n\nNeeds confirm because:\n- cost $120.00 is at or above $100" }),
    run: async (argv: string[], chatKey: string) => {
      assert.equal(chatKey, "telegram:42");
      written.push(argv);
      return JSON.stringify({ inserted: true });
    },
  };
  const msg = { message_id: 1, chat: { id: 42 }, from: { id: 7 } };
  const api = (sent: Sent[], edits: string[]) => ({
    sendMessage: async (_c: number, text: string, extra?: Sent["extra"]) => void sent.push({ text, extra }),
    editMessageText: async (_c: number, _m: number, text: string) => (edits.push(text), null),
    answerCallback: async () => undefined,
  });
  // Direct write (no confirm needed).
  const direct: Sent[] = [];
  mock.timers.enable({ apis: ["Date"], now: NOW }); // "today" must not depend on the host clock (SG date differs from UTC in the evening)
  try {
    await dispatchProseIntercept(api(direct, []) as never, msg as never, "store ev charge today 23523km 64.84kWh", {
      evAdd: { ...evAdd, preview: async () => ({ needsConfirm: false, summary: "" }) },
    });
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(written[0], ["sheet", "ev", "add", "2026-10-05", "--energy", "64.84", "--odometer", "23523"]);
  assert.match(direct[0].text, /^Logged EV charge/);
  for (const choice of ["cancel", "yes"]) {
    const before = written.length;
    const sent: Sent[] = [];
    await dispatchProseIntercept(api(sent, []) as never, msg as never, "store ev charge today 23523km 64.84kWh $120", { evAdd });
    assert.match(sent[0].text, /Needs confirm because/);
    assert.equal(written.length, before);
    const data = (sent[0].extra?.reply_markup?.inline_keyboard[0] ?? []).map((b) => b.callback_data).find((d) => d.endsWith(`:${choice}`)) as string;
    assert.match(data, /^pi:ba:/);
    const edits: string[] = [];
    await handleProseCallback(api([], edits) as never, { id: "1", data, from: { id: 7 }, message: { chat: { id: 42 }, message_id: 9 } } as never, { evAdd });
    assert.equal(written.length, choice === "yes" ? before + 1 : before);
    assert.match(edits[0], choice === "yes" ? /^Logged EV charge/ : /^Cancelled\.$/);
  }
});

test("the profile vehicle name, typed in any case, reaches the ev show and add flows", () => {
  const config = mkdtempSync(path.join(tmpdir(), "ev-profile-"));
  writeFileSync(path.join(config, "profile.toml"), 'vehicle = "Volt"\n');
  const previous = process.env.MELVBOT_CONFIG_DIR;
  process.env.MELVBOT_CONFIG_DIR = config;
  try {
    assert.equal(parseEvShowDirective("show VOLT charges"), true);
    assert.equal(parseEvAddDirective("log volt charge today 23523km 64.84kWh", NOW)?.energyKwh, "64.84");
  } finally {
    if (previous === undefined) {
      delete process.env.MELVBOT_CONFIG_DIR;
    } else {
      process.env.MELVBOT_CONFIG_DIR = previous;
    }
  }
});
