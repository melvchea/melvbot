import { vehicleName } from "../profile.js";
import type { TelegramApi, TelegramUpdate } from "./api.js";
import {
  PROSE_CANCEL,
  PROSE_CONFIRM,
  parseProseCallback,
  storeEvAddOffer,
  storeSpendAddOffer,
  takeEvAddOffer,
  takeSpendAddOffer,
  storeSpendEditOffer,
  takeSpendEditOffer,
} from "./prose_callbacks.js";
import { writeEvEntry, type EvAddDeps } from "./ev_add.js";
import { runSpendEdit } from "./spend_edit.js";
import { writeSpendEntries, type SpendAddDeps } from "./spend_add.js";

export async function handleProseCallback(
  api: TelegramApi,
  update: NonNullable<TelegramUpdate["callback_query"]>,
  deps: { spendAdd?: SpendAddDeps; evAdd?: EvAddDeps } = {},
): Promise<boolean> {
  const parsed = parseProseCallback(update.data ?? "");
  if (!parsed) {
    return false;
  }
  const chatId = update.message?.chat.id;
  const messageId = update.message?.message_id;
  if (chatId === undefined) {
    await api.answerCallback(update.id, "expired");
    return true;
  }

  if (parsed.kind === "spend_add") {
    const offer = takeSpendAddOffer(parsed.nonce);
    if (!offer) {
      await api.answerCallback(update.id, "expired");
      return true;
    }
    if (offer.senderId && update.from.id !== offer.senderId) {
      storeSpendAddOffer(offer, parsed.nonce);
      await api.answerCallback(update.id, "not your picker");
      return true;
    }
    let reply = "Cancelled.";
    if (parsed.choice === PROSE_CONFIRM) {
      try {
        reply = await writeSpendEntries(offer.card, offer.entries, offer.chatKey, deps.spendAdd ?? {});
      } catch (error) {
        reply = `Could not log spend: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (messageId !== undefined) {
      await api.editMessageText(chatId, messageId, reply);
    }
    await api.answerCallback(update.id);
    return true;
  }

  if (parsed.kind === "spend_edit") {
    const offer = takeSpendEditOffer(parsed.nonce);
    if (!offer) {
      await api.answerCallback(update.id, "expired");
      return true;
    }
    if (offer.senderId && update.from.id !== offer.senderId) {
      storeSpendEditOffer(offer, parsed.nonce);
      await api.answerCallback(update.id, "not your picker");
      return true;
    }
    let reply = "Cancelled.";
    if (parsed.choice === PROSE_CONFIRM) {
      try {
        reply = await runSpendEdit(offer.argvs, offer.chatKey, deps.spendAdd ?? {});
      } catch (error) {
        reply = `Could not edit spend: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (messageId !== undefined) {
      await api.editMessageText(chatId, messageId, reply);
    }
    await api.answerCallback(update.id);
    return true;
  }

  if (parsed.kind === "ev_add") {
    const offer = takeEvAddOffer(parsed.nonce);
    if (!offer) {
      await api.answerCallback(update.id, "expired");
      return true;
    }
    if (offer.senderId && update.from.id !== offer.senderId) {
      storeEvAddOffer(offer, parsed.nonce);
      await api.answerCallback(update.id, "not your picker");
      return true;
    }
    let reply = "Cancelled.";
    if (parsed.choice === PROSE_CONFIRM) {
      try {
        reply = await writeEvEntry(offer.entry, offer.chatKey, deps.evAdd ?? {});
      } catch (error) {
        reply = `Could not log ${vehicleName()} charge: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (messageId !== undefined) {
      await api.editMessageText(chatId, messageId, reply);
    }
    await api.answerCallback(update.id);
    return true;
  }

  return false;
}
