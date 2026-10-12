import assert from "node:assert/strict";
import test from "node:test";

import { parseSpendOps } from "../src/sheet/spend_prose.js";
import { dispatchProseIntercept, } from "../src/telegram/prose_intercept.js";
import { handleProseCallback } from "../src/telegram/prose_callback_handler.js";
import { mockApi } from "./helpers/telegram_api.js";
import { FIXTURE_PROFILE, withProfile } from "./helpers/profile.js";

withProfile(FIXTURE_PROFILE);

const NOW = new Date("2026-10-03T04:00:00Z");
type Sent = { text: string; extra?: { reply_markup?: { inline_keyboard: { callback_data: string }[][] } } };
const msg = { message_id: 1, chat: { id: 42 }, from: { id: 7 } };

test("spend add writes with the chat key and replies with totals", async () => {
  const sent: Sent[] = [];
  const calls: { argv: string[]; chatKey: string }[] = [];
  const handled = await dispatchProseIntercept(mockApi({ sent }) as never, msg as never, "store these under bob\n1 Oct Grab 21.10\n1 Oct Grab 16.70", {
    spendAdd: {
      preview: async () => ({ needsConfirm: false, summary: "" }),
      run: async (argv, chatKey) => {
        calls.push({ argv, chatKey });
        return JSON.stringify({ inserted: calls.length === 1, near_duplicates: [] });
      },
      totals: async () => "Met Target $800",
    },
  });
  assert.equal(handled, true);
  assert.equal(calls[0].chatKey, "telegram:42");
  assert.deepEqual(calls[0].argv, ["sheet", "spend", "add", "--owner", "owner2", "--card", "card2", "2026-10-01", "Grab", "21.10"]);
  assert.equal(sent[0].text, "Logged Grab $21.10 → Bob CardTwo (1 Oct)\nAlready logged Grab $16.70 → Bob CardTwo (1 Oct)\n\nMet Target $800");
});

test("a message that is not a spend line is not intercepted or added", async () => {
  const sent: Sent[] = [];
  const calls: string[][] = [];
  const handled = await dispatchProseIntercept(mockApi({ sent }) as never, msg as never, "store these under bob\n1 Oct Grab 21.10\nnot a line", {
    spendAdd: {
      preview: async () => ({ needsConfirm: false, summary: "" }),
      run: async (argv) => (calls.push(argv), JSON.stringify({ inserted: true, near_duplicates: [] })),
      totals: async () => "",
    },
  });
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);
});

test("spend add needing confirm stores an offer; Confirm writes, Cancel does not", async () => {
  const written: string[][] = [];
  const spendAdd = {
    preview: async () => ({ needsConfirm: true, summary: "Log?\n\nNeeds confirm because:\n- amount $600.00 is at or above $500" }),
    run: async (argv: string[]) => {
      written.push(argv);
      return JSON.stringify({ inserted: true });
    },
    totals: async () => "T",
  };
  for (const choice of ["yes", "cancel"]) {
    const sent: Sent[] = [];
    await dispatchProseIntercept(mockApi({ sent }) as never, msg as never, "store bob Rolex 600 today", { spendAdd });
    assert.match(sent[0].text, /Needs confirm because/);
    assert.equal(written.length, choice === "yes" ? 0 : 1);
    const keyboard = sent[0].extra?.reply_markup?.inline_keyboard[0] ?? [];
    const data = keyboard.map((b) => b.callback_data).find((d) => d.endsWith(`:${choice}`)) as string;
    assert.match(data, /^pi:sa:/);
    const edits: string[] = [];
    await handleProseCallback(mockApi({ edits }) as never, { id: "1", data, from: { id: 7 }, message: { chat: { id: 42 }, message_id: 9 } } as never, { spendAdd });
    if (choice === "yes") {
      assert.equal(written.length, 1);
      assert.equal(written[0][9], "600");
      assert.match(edits[0], /^Logged Rolex \$600 → Bob CardTwo/);
    } else {
      assert.equal(written.length, 1);
      assert.equal(edits[0], "Cancelled.");
    }
  }
});

test("spend ops: date-first multi-item, bare line with remembered card, amend and delete rows, combined message", async () => {
  const ops = parseSpendOps("add 4 Oct Shopee $32.19 Vending $2 Vending $2", NOW);
  assert.deepEqual(ops?.[0].kind === "add" && ops[0].entries.map((e) => `${e.spentOn} ${e.merchant} ${e.amount}`), ["2026-10-04 Shopee 32.19", "2026-10-04 Vending 2", "2026-10-04 Vending 2"]);
  const update = parseSpendOps("update alice cardone spend today Vending $2 Vending2 $2.50 Vending3 $2", NOW);
  assert.deepEqual(update?.map((op) => op.kind === "add" && op.entries.map((e) => e.merchant)), [["Vending", "Vending2", "Vending3"]]);
  assert.equal((parseSpendOps("update the pay $5", NOW)?.[0] as { noCard?: string } | undefined)?.noCard, "claude"); // no card named: left to Claude
  assert.equal(parseSpendOps("Where is the nearest MRT", NOW), null);
  assert.equal(parseSpendOps("I paid $5 for lunch", NOW), null);
  assert.equal(parseSpendOps("amend the doc to be shorter", NOW), null);

  const sent: Sent[] = [];
  const written: string[][] = [];
  const rows = [
    { id: "12", merchant: "KFC $11.55 and Shopee", amount: "17.28", spent_on: "2026-10-05", voided_at: null },
    { id: "13", merchant: "Grab", amount: "5", spent_on: "2026-10-05", voided_at: null },
  ];
  const spendAdd = {
    preview: async () => ({ needsConfirm: false, summary: "" }),
    run: async (argv: string[]) => {
      written.push(argv);
      return JSON.stringify({ inserted: true });
    },
    totals: async () => "",
    rows: async () => rows as never,
  };
  const chat = { message_id: 1, chat: { id: 77 }, from: { id: 7 } };
  // No remembered card yet: ask.
  await dispatchProseIntercept(mockApi({ sent }) as never, chat as never, "Vending $2 4 Oct", { spendAdd });
  assert.equal(sent[0].text, "Name CardTwo or CardOne.");
  await dispatchProseIntercept(mockApi({ sent }) as never, chat as never, "add CardOne Grab $5", { spendAdd });
  await dispatchProseIntercept(mockApi({ sent }) as never, chat as never, "Vending $2 4 Oct", { spendAdd });
  assert.deepEqual(written[1], ["sheet", "spend", "add", "--owner", "owner1", "--card", "card1", "2026-10-04", "Vending", "2"]);

  // Combined: amend (confirm keyboard) then add, in order, card shared from the first part.
  sent.length = 0;
  written.length = 0;
  await dispatchProseIntercept(mockApi({ sent }) as never, chat as never, "for CardOne, amend KFC $11.55 and Shopee to be Shopee  add KFC $11.55 on 5 Oct", { spendAdd });
  assert.match(sent[0].text, /^Rename 1 row\(s\) in Alice CardOne to "Shopee"\?/);
  assert.match(sent[1].text, /^Logged KFC \$11.55 → Alice CardOne \(5 Oct\)/);
  assert.equal(written.length, 1);
  const data = sent[0].extra?.reply_markup?.inline_keyboard[0].find((b) => b.callback_data.endsWith(":yes"))?.callback_data as string;
  const edits: string[] = [];
  await handleProseCallback(mockApi({ edits }) as never, { id: "1", data, from: { id: 7 }, message: { chat: { id: 77 }, message_id: 9 } } as never, { spendAdd });
  assert.deepEqual(written[1], ["sheet", "spend", "add", "--owner", "owner1", "--card", "card1", "--void", "12", "2026-10-05", "Shopee", "17.28"]);
  assert.equal(edits[0], "Renamed 1 row(s).");

  // Delete after confirm; no match is reported without Claude.
  sent.length = 0;
  await dispatchProseIntercept(mockApi({ sent }) as never, chat as never, "delete 'KFC $11.55 and Shopee' line item from CardOne spend", { spendAdd });
  assert.match(sent[0].text, /^Delete 1 row\(s\) from Alice CardOne\?/);
  const del = sent[0].extra?.reply_markup?.inline_keyboard[0].find((b) => b.callback_data.endsWith(":yes"))?.callback_data as string;
  await handleProseCallback(mockApi({ edits }) as never, { id: "2", data: del, from: { id: 7 }, message: { chat: { id: 77 }, message_id: 9 } } as never, { spendAdd });
  assert.deepEqual(written.at(-1), ["sheet", "spend", "void", "12"]);
  await dispatchProseIntercept(mockApi({ sent }) as never, chat as never, "delete 'Nope' line item from CardOne spend", { spendAdd });
  assert.equal(sent[1].text, "No matching row in Alice CardOne.");
});
