import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRulesArgs } from "../../src/sheet/cli.js";
import { deleteSheetRule, setSheetRule } from "../../src/sheet/rules_write.js";
import { stubFetch } from "../helpers/fetch.js";
import { googleHome } from "../helpers/google_home.js";

type FakeSheet = { values: string[][] };

function installFakeSheetsClient(sheets: Record<string, FakeSheet>): {
  cleanup: () => void;
} {
  const { restore: restoreEnv } = googleHome({ sheetIds: ["owner1-id", "owner2-id", "ev-id"] });
  const stub = stubFetch((url, init) => {
    const href = url.href;
    const match = /spreadsheets\/([^/]+)\/values\/([^?:]+)/.exec(href);
    if (!match) {
      throw new Error(`unexpected fetch: ${href}`);
    }
    const [, spreadsheetId, encodedRange] = match;
    const key = decodeURIComponent(spreadsheetId);
    const sheet = sheets[key];
    if (!sheet) {
      throw new Error(`no fake sheet for ${key}`);
    }
    const range = decodeURIComponent(encodedRange);
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return { ok: true, json: async () => ({ values: sheet.values }) } as Response;
    }
    const body = JSON.parse(String(init?.body)) as { values: string[][] };
    if (href.includes(":append")) {
      sheet.values.push(...body.values);
      return { ok: true, json: async () => ({}) } as Response;
    }
    // PUT to a specific row, e.g. 'Rules'!A3
    const rowMatch = /!A(\d+)/.exec(range);
    if (!rowMatch) {
      throw new Error(`unexpected range: ${range}`);
    }
    const rowIndex = Number.parseInt(rowMatch[1], 10) - 1;
    sheet.values[rowIndex] = body.values[0];
    return { ok: true, json: async () => ({}) } as Response;
  });
  return {
    cleanup: () => {
      stub.restore();
      restoreEnv();
    },
  };
}

function owner1Sheet(target = "625.00"): Record<string, FakeSheet> {
  return {
    "owner1-id": { values: [["key", "value"], ["cycle", "monthly"], ["target", target]] },
    "owner2-id": { values: [["key", "value"], ["target", "800.00"], ["limit", "1333.00"]] },
    "ev-id": { values: [["key", "value"], ["car", "EV M6"]] },
  };
}

test("set updates the existing row in place; set appends only for a new key", async () => {
  const sheets = owner1Sheet();
  const { cleanup } = installFakeSheetsClient(sheets);
  try {
    const change = await setSheetRule("owner1", "target", "700.00");
    assert.equal(change.sheet, "owner1");
    assert.equal(change.key, "target");
    assert.equal(change.oldValue, "625.00");
    assert.equal(change.newValue, "700.00");
    assert.equal(change.receipt?.verified, true);
    assert.deepEqual(sheets["owner1-id"].values[2], ["target", "700.00"]);
    assert.equal(sheets["owner1-id"].values.length, 3);
  } finally {
    cleanup();
  }
  {
    const sheets = owner1Sheet();
    const { cleanup } = installFakeSheetsClient(sheets);
    try {
      await setSheetRule("ev", "notes", "checked monthly");
      assert.deepEqual(sheets["ev-id"].values[2], ["notes", "checked monthly"]);
      assert.equal(sheets["ev-id"].values.length, 3);
    } finally {
      cleanup();
    }
  }
});

test("a money value of 800 or SGD 800 is refused, and 800.00 is accepted; deleting a money key is refused", async () => {
  const sheets = owner1Sheet();
  const { cleanup } = installFakeSheetsClient(sheets);
  try {
    await assert.rejects(() => setSheetRule("owner1", "target", "800"));
    await assert.rejects(() => setSheetRule("owner1", "target", "SGD 800"));
    await assert.doesNotReject(() => setSheetRule("owner1", "target", "800.00"));
  } finally {
    cleanup();
  }
  {
    const sheets = owner1Sheet();
    const { cleanup } = installFakeSheetsClient(sheets);
    try {
      await assert.rejects(() => deleteSheetRule("owner1", "target"), /can be changed but not deleted/);
    } finally {
      cleanup();
    }
  }
});

test("rules args accept an owner or card display name, as the model passes them", () => {
  assert.deepEqual(parseRulesArgs(["owner1", "target", "1000.00"]), { sheet: "owner1", rest: ["target", "1000.00"] });
  assert.deepEqual(parseRulesArgs(["Owner 1", "Card 1", "target", "1000.00"]), { sheet: "owner1", rest: ["target", "1000.00"] });
  assert.deepEqual(parseRulesArgs(["owner2", "card2", "limit", "5"]), { sheet: "owner2", rest: ["limit", "5"] });
  assert.equal(parseRulesArgs(["nobody", "target", "1"]).sheet, null);
});
