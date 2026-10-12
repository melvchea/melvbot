import { randomBytes } from "node:crypto";

import type { EvAddDirective } from "../sheet/ev_prose.js";
import type { SpendCard } from "../sheet/spend_cycle.js";
import type { SpendAddEntry } from "../sheet/spend_prose.js";

export const PROSE_CALLBACK_PREFIX = "pi:";

export const NOTE_DELETE_PREFIX = `${PROSE_CALLBACK_PREFIX}nd:`;
export const NOTE_COMBINE_PREFIX = `${PROSE_CALLBACK_PREFIX}nc:`;
export const SHEET_ACTION_PREFIX = `${PROSE_CALLBACK_PREFIX}sd:`;
export const SPEND_ADD_PREFIX = `${PROSE_CALLBACK_PREFIX}sa:`;
export const SPEND_EDIT_PREFIX = `${PROSE_CALLBACK_PREFIX}se:`;
export const EV_ADD_PREFIX = `${PROSE_CALLBACK_PREFIX}ba:`;

export const PROSE_CONFIRM_DELETE = "yes";
export const PROSE_CONFIRM = "yes";
export const PROSE_CANCEL = "cancel";
export const PROSE_CREATE = "create";
export const PROSE_DELETE_EXISTING = "delete";

type NoteDeleteOffer = {
  slug: string;
  senderId: number;
};

type NoteCombineOffer = {
  targetSlug: string;
  title: string;
  body: string;
  tags: string[];
  senderId: number;
};

type SheetActionOffer = {
  sheet: "owner1" | "owner2" | "ev";
  senderId: number;
};

type SpendAddOffer = {
  card: SpendCard;
  entries: SpendAddEntry[];
  chatKey: string;
  senderId: number;
};

type SpendEditOffer = {
  argvs: string[][];
  chatKey: string;
  senderId: number;
};

type EvAddOffer = {
  entry: EvAddDirective;
  chatKey: string;
  senderId: number;
};

const spendAddOffers = new Map<string, SpendAddOffer>();
const spendEditOffers = new Map<string, SpendEditOffer>();
const evAddOffers = new Map<string, EvAddOffer>();
const noteDeleteOffers = new Map<string, NoteDeleteOffer>();
const noteCombineOffers = new Map<string, NoteCombineOffer>();
const sheetActionOffers = new Map<string, SheetActionOffer>();

export function newProseNonce(): string {
  return randomBytes(9).toString("base64url");
}

export function storeNoteDeleteOffer(offer: NoteDeleteOffer, nonce = newProseNonce()): string {
  noteDeleteOffers.set(nonce, offer);
  return nonce;
}

export function takeNoteDeleteOffer(nonce: string): NoteDeleteOffer | undefined {
  const offer = noteDeleteOffers.get(nonce);
  if (offer) {
    noteDeleteOffers.delete(nonce);
  }
  return offer;
}

export function storeNoteCombineOffer(offer: NoteCombineOffer, nonce = newProseNonce()): string {
  noteCombineOffers.set(nonce, offer);
  return nonce;
}

export function takeNoteCombineOffer(nonce: string): NoteCombineOffer | undefined {
  const offer = noteCombineOffers.get(nonce);
  if (offer) {
    noteCombineOffers.delete(nonce);
  }
  return offer;
}

export function storeSheetActionOffer(offer: SheetActionOffer, nonce = newProseNonce()): string {
  sheetActionOffers.set(nonce, offer);
  return nonce;
}

export function takeSheetActionOffer(nonce: string): SheetActionOffer | undefined {
  const offer = sheetActionOffers.get(nonce);
  if (offer) {
    sheetActionOffers.delete(nonce);
  }
  return offer;
}

export function storeSpendAddOffer(offer: SpendAddOffer, nonce = newProseNonce()): string {
  spendAddOffers.set(nonce, offer);
  return nonce;
}

export function takeSpendAddOffer(nonce: string): SpendAddOffer | undefined {
  const offer = spendAddOffers.get(nonce);
  if (offer) {
    spendAddOffers.delete(nonce);
  }
  return offer;
}

export function storeSpendEditOffer(offer: SpendEditOffer, nonce = newProseNonce()): string {
  spendEditOffers.set(nonce, offer);
  return nonce;
}

export function takeSpendEditOffer(nonce: string): SpendEditOffer | undefined {
  const offer = spendEditOffers.get(nonce);
  if (offer) {
    spendEditOffers.delete(nonce);
  }
  return offer;
}

export function buildSpendEditKeyboard(nonce: string): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: `${SPEND_EDIT_PREFIX}${nonce}:${PROSE_CONFIRM}` },
        { text: "Cancel", callback_data: `${SPEND_EDIT_PREFIX}${nonce}:${PROSE_CANCEL}` },
      ],
    ],
  };
}

export function storeEvAddOffer(offer: EvAddOffer, nonce = newProseNonce()): string {
  evAddOffers.set(nonce, offer);
  return nonce;
}

export function takeEvAddOffer(nonce: string): EvAddOffer | undefined {
  const offer = evAddOffers.get(nonce);
  if (offer) {
    evAddOffers.delete(nonce);
  }
  return offer;
}

export function buildEvAddKeyboard(nonce: string): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: `${EV_ADD_PREFIX}${nonce}:${PROSE_CONFIRM}` },
        { text: "Cancel", callback_data: `${EV_ADD_PREFIX}${nonce}:${PROSE_CANCEL}` },
      ],
    ],
  };
}

export function buildSpendAddKeyboard(nonce: string): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: `${SPEND_ADD_PREFIX}${nonce}:${PROSE_CONFIRM}` },
        { text: "Cancel", callback_data: `${SPEND_ADD_PREFIX}${nonce}:${PROSE_CANCEL}` },
      ],
    ],
  };
}

export function noteDeleteCallbackData(nonce: string, choice: typeof PROSE_CONFIRM_DELETE | typeof PROSE_CANCEL): string {
  return `${NOTE_DELETE_PREFIX}${nonce}:${choice}`;
}

export function sheetActionCallbackData(
  nonce: string,
  choice: typeof PROSE_CREATE | typeof PROSE_DELETE_EXISTING | typeof PROSE_CANCEL,
): string {
  return `${SHEET_ACTION_PREFIX}${nonce}:${choice}`;
}

export function noteCombineCallbackData(
  nonce: string,
  choice: typeof PROSE_CONFIRM | typeof PROSE_CANCEL,
): string {
  return `${NOTE_COMBINE_PREFIX}${nonce}:${choice}`;
}

export function buildNoteCombineKeyboard(nonce: string): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: noteCombineCallbackData(nonce, PROSE_CONFIRM) },
        { text: "Cancel", callback_data: noteCombineCallbackData(nonce, PROSE_CANCEL) },
      ],
    ],
  };
}

export function buildNoteDeleteKeyboard(nonce: string): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: [
      [
        { text: "Delete", callback_data: noteDeleteCallbackData(nonce, PROSE_CONFIRM_DELETE) },
        { text: "Cancel", callback_data: noteDeleteCallbackData(nonce, PROSE_CANCEL) },
      ],
    ],
  };
}

export function buildSheetActionKeyboard(nonce: string): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: [
      [
        { text: "Create new", callback_data: sheetActionCallbackData(nonce, PROSE_CREATE) },
        { text: "Delete existing", callback_data: sheetActionCallbackData(nonce, PROSE_DELETE_EXISTING) },
      ],
      [{ text: "Cancel", callback_data: sheetActionCallbackData(nonce, PROSE_CANCEL) }],
    ],
  };
}

export function parseProseCallback(
  data: string,
):
  | { kind: "note_delete"; nonce: string; choice: typeof PROSE_CONFIRM_DELETE | typeof PROSE_CANCEL }
  | { kind: "note_combine"; nonce: string; choice: typeof PROSE_CONFIRM | typeof PROSE_CANCEL }
  | { kind: "spend_add"; nonce: string; choice: typeof PROSE_CONFIRM | typeof PROSE_CANCEL }
  | { kind: "spend_edit"; nonce: string; choice: typeof PROSE_CONFIRM | typeof PROSE_CANCEL }
  | { kind: "ev_add"; nonce: string; choice: typeof PROSE_CONFIRM | typeof PROSE_CANCEL }
  | { kind: "sheet_action"; nonce: string; choice: typeof PROSE_CREATE | typeof PROSE_DELETE_EXISTING | typeof PROSE_CANCEL }
  | null {
  if (data.startsWith(NOTE_COMBINE_PREFIX)) {
    const payload = data.slice(NOTE_COMBINE_PREFIX.length);
    const split = payload.lastIndexOf(":");
    if (split <= 0) {
      return null;
    }
    const nonce = payload.slice(0, split);
    const choice = payload.slice(split + 1);
    if (choice === PROSE_CONFIRM || choice === PROSE_CANCEL) {
      return { kind: "note_combine", nonce, choice };
    }
    return null;
  }
  if (data.startsWith(NOTE_DELETE_PREFIX)) {
    const payload = data.slice(NOTE_DELETE_PREFIX.length);
    const split = payload.lastIndexOf(":");
    if (split <= 0) {
      return null;
    }
    const nonce = payload.slice(0, split);
    const choice = payload.slice(split + 1);
    if (choice === PROSE_CONFIRM_DELETE || choice === PROSE_CANCEL) {
      return { kind: "note_delete", nonce, choice };
    }
    return null;
  }
  if (data.startsWith(SPEND_ADD_PREFIX)) {
    const payload = data.slice(SPEND_ADD_PREFIX.length);
    const split = payload.lastIndexOf(":");
    if (split <= 0) {
      return null;
    }
    const nonce = payload.slice(0, split);
    const choice = payload.slice(split + 1);
    if (choice === PROSE_CONFIRM || choice === PROSE_CANCEL) {
      return { kind: "spend_add", nonce, choice };
    }
    return null;
  }
  if (data.startsWith(SPEND_EDIT_PREFIX)) {
    const payload = data.slice(SPEND_EDIT_PREFIX.length);
    const split = payload.lastIndexOf(":");
    if (split <= 0) {
      return null;
    }
    const nonce = payload.slice(0, split);
    const choice = payload.slice(split + 1);
    if (choice === PROSE_CONFIRM || choice === PROSE_CANCEL) {
      return { kind: "spend_edit", nonce, choice };
    }
    return null;
  }
  if (data.startsWith(EV_ADD_PREFIX)) {
    const payload = data.slice(EV_ADD_PREFIX.length);
    const split = payload.lastIndexOf(":");
    if (split <= 0) {
      return null;
    }
    const nonce = payload.slice(0, split);
    const choice = payload.slice(split + 1);
    if (choice === PROSE_CONFIRM || choice === PROSE_CANCEL) {
      return { kind: "ev_add", nonce, choice };
    }
    return null;
  }
  if (data.startsWith(SHEET_ACTION_PREFIX)) {
    const payload = data.slice(SHEET_ACTION_PREFIX.length);
    const split = payload.lastIndexOf(":");
    if (split <= 0) {
      return null;
    }
    const nonce = payload.slice(0, split);
    const choice = payload.slice(split + 1);
    if (choice === PROSE_CREATE || choice === PROSE_DELETE_EXISTING || choice === PROSE_CANCEL) {
      return { kind: "sheet_action", nonce, choice };
    }
    return null;
  }
  return null;
}
