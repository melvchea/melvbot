import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LIST_CALLBACK_PREFIX = "sl:";
const TITLE = "🛒 Shopping List";
const BUTTON_TEXT_LIMIT = 64;
const FULL_ROW_NAME_CHARS = 20;
const MAX_TEXT_ITEMS = 100;
const LEADING_MARKER = /^(?:[-*•·–—]|\d+[.)]|\[[ xX]?\]|[☐☑☒✅✔❌]️?)\s*/;

export type ShoppingItem = { name: string; text?: string; done: boolean };
export type ShoppingState = {
  items: ShoppingItem[];
  last_chat_id?: number;
  last_message_id?: number;
  owner_user_id?: number;
};

export function shoppingListPath(): string {
  const configDir = process.env.MELVBOT_CONFIG_DIR;
  if (configDir) {
    return path.join(configDir, "shopping_list.json");
  }
  return path.join(
    process.env.HOME ?? "/home/melvbot",
    "melvbot-workspace",
    "melvbot-data",
    "config",
    "shopping_list.json",
  );
}

export function itemName(item: ShoppingItem): string {
  return String(item.name || item.text || "").trim();
}

export function loadShoppingList(filePath = shoppingListPath()): ShoppingState {
  if (!existsSync(filePath)) {
    return { items: [] };
  }
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as ShoppingState;
  if (!Array.isArray(raw.items)) {
    return { items: [] };
  }
  return raw;
}

export function saveShoppingList(data: ShoppingState, filePath = shoppingListPath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, filePath);
}

export function parseTextItems(text: string): string[] {
  const raw = text.trim();
  if (!raw) {
    return [];
  }
  const chunks = raw.includes("\n") ? raw.split("\n") : raw.includes(",") ? raw.split(",") : [raw];
  const items: string[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const name = chunk.trim().replace(LEADING_MARKER, "").trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(name);
    if (items.length >= MAX_TEXT_ITEMS) {
      break;
    }
  }
  return items;
}

export function addItems(data: ShoppingState, names: string[]): ShoppingState {
  const seen = new Set(data.items.map((item) => itemName(item).toLowerCase()));
  for (const name of names) {
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    data.items.push({ name, done: false });
  }
  return data;
}

const ITEM_WORD = /\p{L}[\p{L}'’]*/gu;

export function titleCaseItem(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim();
  return collapsed.replace(ITEM_WORD, (word) => {
    const lower = word.toLowerCase();
    return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
  });
}

export function replaceItems(data: ShoppingState, names: string[]): ShoppingState {
  const items: ShoppingItem[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = titleCaseItem(raw);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push({ name, done: false });
    if (items.length >= MAX_TEXT_ITEMS) {
      break;
    }
  }
  data.items = items;
  return data;
}

export function formatShoppingMessage(data: ShoppingState): string {
  const total = data.items.length;
  const done = data.items.filter((item) => item.done).length;
  const lines = [TITLE, ""];
  if (total) {
    lines.push(`${done}/${total} done — tap to check off:`);
  } else {
    lines.push("(empty)");
  }
  return lines.join("\n");
}

function buttonLabel(item: ShoppingItem): string {
  const mark = item.done ? "✅" : "⬜";
  const label = `${mark} ${itemName(item)}`;
  if (label.length <= BUTTON_TEXT_LIMIT) {
    return label;
  }
  return `${label.slice(0, BUTTON_TEXT_LIMIT - 3)}...`;
}

export function buildShoppingKeyboard(data: ShoppingState): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  const buttons = data.items.map((item, index) => ({
    text: buttonLabel(item),
    callback_data: `${LIST_CALLBACK_PREFIX}${index}`,
  }));
  const names = data.items.map(itemName);
  const rows: { text: string; callback_data: string }[][] = [];
  let index = 0;
  while (index < buttons.length) {
    if (names[index].length > FULL_ROW_NAME_CHARS) {
      rows.push([buttons[index]]);
      index += 1;
    } else if (
      index + 1 < buttons.length &&
      names[index + 1].length <= FULL_ROW_NAME_CHARS
    ) {
      rows.push([buttons[index], buttons[index + 1]]);
      index += 2;
    } else {
      rows.push([buttons[index]]);
      index += 1;
    }
  }
  return { inline_keyboard: rows };
}

export function parseToggleIndex(callbackData: string): number | null {
  if (!callbackData.startsWith(LIST_CALLBACK_PREFIX)) {
    return null;
  }
  const suffix = callbackData.slice(LIST_CALLBACK_PREFIX.length);
  if (!/^\d+$/.test(suffix)) {
    return null;
  }
  return Number(suffix);
}

export function toggleItem(data: ShoppingState, index: number): ShoppingState {
  if (index >= 0 && index < data.items.length) {
    data.items[index].done = !data.items[index].done;
  }
  return data;
}
