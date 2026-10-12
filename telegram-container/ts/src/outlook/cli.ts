import { getGraphAccessToken } from "./token.js";
import { listInboxMessages, listReplyContext } from "./graph.js";
import { formatDigestMessage, type GraphMessage, type SentMessage } from "./digest_format.js";

const DEFAULT_WINDOW_HOURS = 14;
const MS_PER_HOUR = 3_600_000;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

type InboxRow = {
  id: string;
  subject: string;
  from: string;
  received: string;
  isRead: boolean;
  preview: string;
};

function compact(messages: unknown[]): InboxRow[] {
  return messages.map((raw) => {
    const row = raw as {
      id?: string;
      subject?: string;
      from?: { emailAddress?: { name?: string; address?: string } };
      receivedDateTime?: string;
      isRead?: boolean;
      bodyPreview?: string;
    };
    const from = row.from?.emailAddress;
    return {
      id: row.id ?? "",
      subject: row.subject ?? "(no subject)",
      from: from?.name || from?.address || "",
      received: row.receivedDateTime ?? "",
      isRead: Boolean(row.isRead),
      preview: (row.bodyPreview ?? "").slice(0, 160),
    };
  });
}

export async function runOutlookCli(args: string[]): Promise<number> {
  try {
    if (args[0] === "inbox") {
      const hours = Number(flag(args.slice(1), "--hours") ?? String(DEFAULT_WINDOW_HOURS));
      const windowMs = (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_WINDOW_HOURS) * MS_PER_HOUR;
      const start = new Date(Date.now() - windowMs).toISOString();
      const token = await getGraphAccessToken();
      const { messages, truncated } = await listInboxMessages(token, start);
      writeJson({ truncated, messages: compact(messages) });
      return 0;
    }
    if (args[0] === "digest") {
      // Dry run: print the digest the cron would send, never notify.
      const hours = Number(flag(args.slice(1), "--hours") ?? String(DEFAULT_WINDOW_HOURS));
      const windowMs = (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_WINDOW_HOURS) * MS_PER_HOUR;
      const token = await getGraphAccessToken();
      const { messages, truncated } = await listInboxMessages(token, new Date(Date.now() - windowMs).toISOString());
      const reply = await listReplyContext(token);
      process.stdout.write(
        `${formatDigestMessage(messages as GraphMessage[], {
          slot: "morning",
          truncated,
          reply: { me: reply.me, carry: reply.carry as GraphMessage[], sent: reply.sent as SentMessage[] },
        })}\n`,
      );
      return 0;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${detail}\n`);
    return 1;
  }
  process.stderr.write("usage: melvbot outlook inbox|digest [--hours 14]\n");
  return 2;
}
