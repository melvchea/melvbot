import assert from "node:assert/strict";
import test from "node:test";

import { extractDocText } from "../../src/note/notes_google.js";

const para = (text: string) => ({ paragraph: { elements: [{ textRun: { content: text } }] } });

test("extractDocText keeps text inside tables so a table-based market log is not cut off", () => {
  const text = extractDocText({
    body: {
      content: [
        para("## Market log\n"),
        { table: { tableRows: [{ tableCells: [{ content: [para("9 Oct\n")] }, { content: [para("12 Oct\n")] }] }] } },
        para("tail\n"),
      ],
    },
  });
  assert.equal(text, "## Market log\n9 Oct\n12 Oct\ntail\n");
});
