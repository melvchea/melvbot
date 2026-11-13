import assert from "node:assert/strict";
import test from "node:test";

import { validateProcedureNoteBody } from "../../src/note/note_schema.js";

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

test("the spend-line check skips the dollar-cost-avg Note but still guards other Notes", () => {
  const body = "## Plan\n- SPYL: bought USD 4,500 on 6 Nov\n";
  assert.doesNotThrow(() => validateProcedureNoteBody("dollar-cost-avg", body));
  assert.throws(() => validateProcedureNoteBody("tv-buy", body), /looks like a spend record/);
});
