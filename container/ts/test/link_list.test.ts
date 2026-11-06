import assert from "node:assert/strict";
import test from "node:test";

import { assembleLinkListLines } from "../src/telegram/link_list.js";

test("link covers only the label, not the plain prefix", () => {
  const msg = assembleLinkListLines(
    [
      { prefix: "a-b — ", label: "One", url: "https://x/1" },
      { prefix: "c-d — ", label: "Two", url: "https://x/2" },
    ],
    "none",
  );
  assert.equal(msg.text, "a-b — One\nc-d — Two");
  assert.deepEqual(
    msg.entities.map((e) => msg.text.slice(e.offset, e.offset + e.length)),
    ["One", "Two"],
  );
});
