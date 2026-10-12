import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDigestMessage,
  type GraphMessage,
  type ReplyContext,
  type SentMessage,
} from "../../src/outlook/digest_format.js";

const ME = "me@example.com";
const NOW = new Date("2026-10-03T08:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function mail(id: string, over: Partial<GraphMessage> & { hoursAgo?: number; addr?: string } = {}): GraphMessage {
  const { hoursAgo = 5, addr = `${id}@person.com`, ...rest } = over;
  return {
    id,
    conversationId: `c-${id}`,
    subject: `Subject ${id}`,
    from: { emailAddress: { name: `Person ${id}`, address: addr } },
    toRecipients: [{ emailAddress: { address: ME } }],
    ccRecipients: [],
    receivedDateTime: ago(hoursAgo),
    isRead: false,
    inferenceClassification: "focused",
    bodyPreview: "",
    ...rest,
  };
}

function digest(carry: GraphMessage[], sent: SentMessage[] = [], window: GraphMessage[] = carry): string {
  const reply: ReplyContext = { me: ME, carry, sent };
  return formatDigestMessage(window, { slot: "morning", now: NOW, reply });
}

const sentTo = (address: string, hoursAgo: number, conversationId = "x"): SentMessage => ({
  conversationId,
  sentDateTime: ago(hoursAgo),
  toRecipients: [{ emailAddress: { address } }],
});

test("direct question from known contact is included with tags", () => {
  const m = mail("k", { subject: "Report", bodyPreview: "Could you send it by Friday?", hoursAgo: 80 });
  const text = digest([m], [sentTo("k@person.com", 24 * 20, "old")]);
  assert.match(text, /Reply needed \(1\):\n• Person k — Report · 3d · direct, question, due Fri, known/);
});
