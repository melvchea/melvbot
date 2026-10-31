import assert from "node:assert/strict";
import test from "node:test";
import { ocrImage } from "../src/media/services.js";

test("Haiku OCR rejects unsupported and oversized images before calling Claude", async () => {
  await assert.rejects(ocrImage(Buffer.from("x"), "image/heic"), /unsupported image type/);
  await assert.rejects(ocrImage(Buffer.alloc(10 * 1024 * 1024 + 1), "image/png"), /larger than 10 MB/);
});
