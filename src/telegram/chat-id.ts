import { z } from "zod";
import { loadConfig } from "../config.js";

/**
 * Helper for finding your Telegram chat ID. Send your bot any message first,
 * then run `npm run telegram:chat-id`. It calls getUpdates and prints the chat
 * id(s) the bot has seen so you can paste one into TELEGRAM_CHAT_ID.
 */
const updatesResponse = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  result: z
    .array(
      z.object({
        message: z
          .object({
            chat: z.object({
              id: z.number(),
              type: z.string().optional(),
              title: z.string().optional(),
              username: z.string().optional(),
              first_name: z.string().optional(),
            }),
          })
          .optional(),
      }),
    )
    .optional(),
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set in .env.");
  }

  const res = await fetch(
    `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/getUpdates`,
  );
  const body = updatesResponse.parse(await res.json());

  if (!body.ok) {
    throw new Error(`Telegram API error: ${body.description ?? "unknown"}`);
  }

  const chats = new Map<number, string>();
  for (const update of body.result ?? []) {
    const chat = update.message?.chat;
    if (!chat) continue;
    const label =
      chat.title ?? chat.username ?? chat.first_name ?? chat.type ?? "(unknown)";
    chats.set(chat.id, label);
  }

  if (chats.size === 0) {
    console.log(
      "No chats found. Send a message to your bot, then run this again.\n" +
        "(getUpdates only returns recent updates, and not while the tracker is polling them.)",
    );
    return;
  }

  console.log("Chats that have messaged your bot:\n");
  for (const [id, label] of chats) {
    console.log(`  ${id}  —  ${label}`);
  }
  console.log("\nCopy the desired id into TELEGRAM_CHAT_ID in .env.");
}

main().catch((err) => {
  console.error(`\n[telegram] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
