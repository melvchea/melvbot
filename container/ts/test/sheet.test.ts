import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { utimesSync } from "node:fs";
import path from "node:path";

import { cardLabel, displayNames } from "../src/profile.js";
import { appendNamed } from "../src/sheet/sheets.js";
import { SHEET_LOCK_STALE_MS, withSheetWriteLock } from "../src/sheet/sheet_lock.js";
import { spendCycle, normalizeSpendCard, spendDedupeKey } from "../src/sheet/spend_cycle.js";
import { findNearDuplicateSpend } from "../src/sheet/spend_dedupe.js";
import { listSpend, listSpendAll } from "../src/sheet/spend_list.js";
import { voidSpend } from "../src/sheet/spend_write.js";
import { setMelvbotEnv } from "./helpers/env.js";
import { googleHome } from "./helpers/google_home.js";
import { jsonResponse, stubFetch } from "./helpers/fetch.js";
import { tempDir } from "./helpers/temp.js";

test("listSpendAll groups non-voided entries by cycle, newest first", async () => {
  const { restore: restoreEnv } = googleHome();
  const head = ["id", "owner", "card", "spent_on", "merchant", "amount", "cycle_start", "cycle_end", "source_ref", "voided_at"];
  const row = (id: string, spent: string, amount: string, start: string, end: string, voided = "") => [
    id, "owner1", "card1", spent, "Shop", amount, start, end, "", voided,
  ];
  const tabs: Record<string, string[][]> = {
    Transactions: [
      head,
      row("1", "2026-08-30", "10.00", "2026-08-27", "2026-09-26"),
      row("2", "2026-09-30", "20.50", "2026-09-27", "2026-10-26"),
      row("3", "2026-10-01", "5.25", "2026-09-27", "2026-10-26"),
      row("4", "2026-10-02", "99.00", "2026-09-27", "2026-10-26", "2026-10-03"),
    ],
    Rules: [["key", "value"], ["target", "500.00"]],
  };
  const stub = stubFetch((url) => {
    const tab = decodeURIComponent(/values\/([^?]+)/.exec(url.href)![1]).replace(/'/g, "");
    return { ok: true, status: 200, json: async () => ({ values: tabs[tab] }) } as Response;
  });
  try {
    const out = await listSpendAll({ owner: "owner1", card: "card1" });
    assert.deepEqual(
      out.cycles.map((c) => [c.cycle_start, c.total, c.headroom, c.entries.length]),
      [["2026-09-27", "25.75", "474.25", 2], ["2026-08-27", "10.00", "490.00", 1]],
    );
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("listSpend returns the cycle's entries oldest date first", async () => {
  const { restore: restoreEnv } = googleHome();
  const head = ["id", "owner", "card", "spent_on", "merchant", "amount", "cycle_start", "cycle_end", "source_ref", "voided_at"];
  const row = (id: string, spent: string) => [id, "owner1", "card1", spent, "Shop", "1.00", "2026-10-01", "2026-10-31", "", ""];
  const tabs: Record<string, string[][]> = {
    Transactions: [head, row("1", "2026-10-05"), row("2", "2026-10-02"), row("3", "2026-10-01")],
    Rules: [["key", "value"], ["target", "500.00"]],
  };
  const stub = stubFetch((url) => {
    const tab = decodeURIComponent(/values\/([^?]+)/.exec(url.href)![1]).replace(/'/g, "");
    return { ok: true, status: 200, json: async () => ({ values: tabs[tab] }) } as Response;
  });
  try {
    const out = await listSpend({ owner: "owner1", card: "card1", cycleDate: "2026-10-06" });
    assert.deepEqual(out.entries.map((e) => e.spent_on), ["2026-10-01", "2026-10-02", "2026-10-05"]);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

// Bug: Transactions had no voided_at header, so void wrote an unnamed column and the row stayed listed.
test("spendDedupeKey treats merchant aliases as the same key; findNearDuplicateSpend flags same date and amount with similar merchant", () => {
  const a = spendDedupeKey({
    owner: "owner1",
    card: "card1",
    spentOn: "2026-09-30",
    merchant: "FairPrice Pte Ltd",
    amount: "12.50",
  });
  const b = spendDedupeKey({
    owner: "owner1",
    card: "card1",
    spentOn: "2026-09-30",
    merchant: "fairprice",
    amount: "12.50",
  });
  assert.equal(a, b);
  const rows = [
    {
      id: "7",
      merchant: "Cold Storage Orchard",
      amount: "42.10",
      spent_on: "2026-09-30",
      dedupe_key: "old-key",
      voided_at: null,
    },
  ];
  const near = findNearDuplicateSpend(rows, {
    spentOn: "2026-09-30",
    merchant: "Cold Storage",
    amount: "42.10",
    dedupeKey: "different-key",
  });
  assert.equal(near.length, 1);
  assert.equal(near[0]?.id, "7");
});

test("appendNamed does not re-send a POST that Google applied before answering 5xx", async () => {
  const { restore: restoreEnv } = googleHome();
  const rows: string[][] = [["id", "merchant"]];
  // Fake Sheets API: the append lands, then the response is a 503 (the lost-response case).
  const stub = stubFetch((url, init) => {
    if (init?.method === "POST") {
      rows.push((JSON.parse(String(init.body)) as { values: string[][] }).values[0]);
      return jsonResponse({ error: { message: "backend error" } }, 503);
    }
    return jsonResponse({ values: rows });
  });
  try {
    await appendNamed("m", "Transactions", ["id", "merchant"], { id: "7", merchant: "Shopee" });
    assert.equal(stub.calls.filter((call) => call.init?.method === "POST").length, 1);
    assert.deepEqual(rows.slice(1), [["7", "Shopee"]]);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("sheet write lock refresh keeps a long write from going stale, so a second writer stays busy", async () => {
  const dir = tempDir("sheet-lock-");
  const restoreEnv = setMelvbotEnv({ MELVBOT_CONFIG_DIR: dir });
  const lockFile = path.join(dir, "sheet_locks", "lock-sheet.lock");
  mock.timers.enable({ apis: ["setInterval"] });
  let finish = () => {};
  const held = withSheetWriteLock("lock-sheet", () => new Promise<void>((resolve) => (finish = () => resolve())));
  try {
    const aged = new Date(Date.now() - SHEET_LOCK_STALE_MS - 1_000);
    utimesSync(lockFile, aged, aged);
    mock.timers.tick(30_000);
    await assert.rejects(withSheetWriteLock("lock-sheet", async () => {}), /sheet write busy: lock-sheet/);
  } finally {
    finish();
    await held;
    mock.timers.reset();
    restoreEnv();
  }
});

test("normalizeSpendCard accepts ids, display names and the full label, rejects mismatches", () => {
  const { owner2, card2 } = displayNames();
  const expected = { owner: "owner2", card: "card2" };
  assert.deepEqual(normalizeSpendCard("owner2", "card2"), expected);
  assert.deepEqual(normalizeSpendCard(owner2.toUpperCase(), card2), expected);
  assert.deepEqual(normalizeSpendCard("owner2", cardLabel("owner2", "card2")), expected);
  assert.throws(() => normalizeSpendCard("owner1", "card2"), /unsupported owner\/card pair/);
});
