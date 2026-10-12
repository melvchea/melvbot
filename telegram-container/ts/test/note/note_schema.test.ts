import assert from "node:assert/strict";
import test from "node:test";

import { assertNoteBodyNotSheetLike, stripHistorySection, validateProcedureNoteBody } from "../../src/note/note_schema.js";

test("procedure notes require a Rules section; procedure notes cannot lose the Rules section once they have it", () => {
  assert.throws(
    () => validateProcedureNoteBody("phone-buy", "## Current pick\nPixel 10\n"),
    /must include a ## Rules section/,
  );
  assert.doesNotThrow(() =>
    validateProcedureNoteBody("phone-buy", "## Rules\nshortlist at most 3\n\n## Current pick\nPixel 10\n"),
  );
  {
    const bodyWithRules = "## Rules\nshortlist at most 3\n\n## Current pick\nPixel 10\n";
    assert.throws(
      () => validateProcedureNoteBody("phone-buy", "## Current pick\nPixel 10\n", bodyWithRules),
      /must include a ## Rules section/,
    );
  }
});
