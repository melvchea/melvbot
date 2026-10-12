import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  addItems,
  loadShoppingList,
  replaceItems,
  saveShoppingList,
} from "../src/telegram/shopping_list.js";
import { tempDir } from "./helpers/temp.js";

const dir = tempDir("shop-");

test("shopping list survives save/load and drops duplicates on add", () => {
  const file = path.join(dir, "list.json");
  const data = addItems({ items: [] }, ["milk", "Milk", "eggs"]);
  saveShoppingList(data, file);
  assert.deepEqual(loadShoppingList(file).items.map((i) => i.name), ["milk", "eggs"]);
});

test("shopping list load falls back to empty on a malformed items field", () => {
  const file = path.join(dir, "bad.json");
  writeFileSync(file, JSON.stringify({ items: "oops" }));
  assert.deepEqual(loadShoppingList(file), { items: [] });
});

test("replaceItems dedupes names and resets done state", () => {
  const data = replaceItems({ items: [{ name: "old", done: true }] }, ["green tea", "green tea"]);
  assert.deepEqual(data.items, [{ name: "Green Tea", done: false }]);
});
