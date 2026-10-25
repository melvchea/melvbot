import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";

import { tempDir } from "./helpers/temp.js";
import { mockApi, type Sent } from "./helpers/telegram_api.js";

await register(new URL("./resolve_ts.mjs", import.meta.url));

const { dispatchProseIntercept } = await import(
  "../src/telegram/prose_intercept.js"
);

function seedToml(root: string): string {
  const tomlPath = path.join(root, "melvbot.toml");
  writeFileSync(
    tomlPath,
    `[sheets]
owner1_spreadsheet_id = "sheet-m"
owner2_spreadsheet_id = "sheet-c"
ev_spreadsheet_id = "sheet-b"

[notes]
`,
  );
  return tomlPath;
}

test("an intercepted exchange is handed to the next Claude turn once, so follow-ups keep context", async () => {
  const { takeInterceptContext } = await import("../src/telegram/intercept_context.js");
  const sent: Sent[] = [];
  const api = mockApi({ sent });
  const other = { message_id: 2, chat: { id: 43 }, from: { id: 7 } };
  process.env.MELVBOT_TOML = seedToml(tempDir("melvbot-prose-context-"));
  await dispatchProseIntercept(api as never, other as never, "list notes", {});
  assert.equal(sent[0].text, "No Notes.");
  assert.match(takeInterceptContext("telegram:43"), /User: list notes\nBot \(instant reply\): .*No Notes/s);
  assert.equal(takeInterceptContext("telegram:43"), "");
});
