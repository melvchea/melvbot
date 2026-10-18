import { randomBytes } from "node:crypto";

import type { EvAddDirective } from "../sheet/ev_prose.js";
import type { SpendCard } from "../sheet/spend_cycle.js";
import type { SpendAddEntry } from "../sheet/spend_prose.js";

export const PROSE_CALLBACK_PREFIX = "pi:";

export const SPEND_ADD_PREFIX = `${PROSE_CALLBACK_PREFIX}sa:`;
export const SPEND_EDIT_PREFIX = `${PROSE_CALLBACK_PREFIX}se:`;
export const EV_ADD_PREFIX = `${PROSE_CALLBACK_PREFIX}ba:`;

export const PROSE_CONFIRM = "yes";
export const PROSE_CANCEL = "cancel";

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

export function newProseNonce(): string {
  return randomBytes(9).toString("base64url");
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

export function parseProseCallback(
  data: string,
):
  | { kind: "spend_add"; nonce: string; choice: typeof PROSE_CONFIRM | typeof PROSE_CANCEL }
  | { kind: "spend_edit"; nonce: string; choice: typeof PROSE_CONFIRM | typeof PROSE_CANCEL }
  | { kind: "ev_add"; nonce: string; choice: typeof PROSE_CONFIRM | typeof PROSE_CANCEL }
  | null {
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
  return null;
}
