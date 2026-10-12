import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanSnippet } from "../../src/assistant/providers/brave_search.js";

test("snippet drops Brave's <strong> tags and decodes entities once, so &amp;lt; stays &lt;", () => {
  assert.equal(cleanSnippet("<strong>Rust</strong> &amp;lt;tag&amp;gt;"), "Rust &lt;tag&gt;");
});
