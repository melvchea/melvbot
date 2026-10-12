export type Sent = {
  chatId?: number;
  text: string;
  entities?: unknown[];
  extra?: { entities?: unknown[]; reply_markup?: unknown };
};
export type Media = { chatId: number; bytes: Buffer; caption?: string };

export type MockApiOptions = {
  sent?: Sent[];
  photos?: Media[];
  videos?: Media[];
  edits?: string[];
  /** Called after each sendVideo, so a test can await the async generation without a timer. */
  onVideo?: () => void;
};

/** Telegram API fake; records what the bot sends into the arrays passed in. */
export function mockApi({ sent = [], photos = [], videos = [], edits = [], onVideo }: MockApiOptions = {}) {
  return {
    sendMessage: async (chatId: number, text: string, extra?: Sent["extra"]) => {
      sent.push({ chatId, text, entities: extra?.entities, extra });
      return { message_id: 9 };
    },
    editMessageText: async (_chatId: number, _messageId: number, text: string) => {
      edits.push(text);
      return null;
    },
    sendPhoto: async (chatId: number, bytes: Buffer, caption?: string) => {
      photos.push({ chatId, bytes, caption });
    },
    sendVideo: async (chatId: number, bytes: Buffer, caption?: string) => {
      videos.push({ chatId, bytes, caption });
      onVideo?.();
    },
    deleteMessage: async () => undefined,
    answerCallback: async () => undefined,
    getUpdates: async () => [],
    getFilePath: async () => "",
    downloadFile: async () => Buffer.from(""),
  };
}
