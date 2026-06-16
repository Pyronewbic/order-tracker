import { z } from "zod";
import type { Logger } from "../logger.js";
import type { OrderStatus } from "../types.js";

const API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

// Every Bot API method returns this envelope.
const apiResponse = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  result: z.unknown().optional(),
});

/** Sends notifications about order status changes. */
export interface Notifier {
  /** Notify that a Notion row's status changed. Never throws. */
  notifyStatusChange(
    book: string,
    status: OrderStatus,
    detail: string,
  ): Promise<void>;
  /** Send a free-form operational message (startup, errors). Never throws. */
  notify(text: string): Promise<void>;
}

export const STATUS_EMOJI: Record<OrderStatus, string> = {
  Delivered: "✅",
  "Arriving Soon": "🚚",
  "In Transit": "📦",
};

/**
 * Build a {@link Notifier}. Returns a no-op notifier when Telegram is not
 * configured, so callers never have to branch on whether it's enabled.
 */
export function createNotifier(
  cfg: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string },
  log: Logger,
): Notifier {
  if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHAT_ID) {
    return new NoopNotifier();
  }
  return new TelegramNotifier(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID, log);
}

class NoopNotifier implements Notifier {
  async notifyStatusChange(): Promise<void> {}
  async notify(): Promise<void> {}
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly log: Logger,
  ) {}

  async notifyStatusChange(
    book: string,
    status: OrderStatus,
    detail: string,
  ): Promise<void> {
    const text =
      `${STATUS_EMOJI[status]} <b>${escapeHtml(book)}</b>\n` +
      `Status: <b>${escapeHtml(status)}</b>\n` +
      `<i>${escapeHtml(detail)}</i>`;
    await this.notify(text);
  }

  /** POST to sendMessage. Logs and swallows errors — notifications are
   * best-effort and must never break the polling loop. */
  async notify(text: string): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const body = apiResponse.safeParse(await res.json().catch(() => ({})));
      if (!res.ok || !body.success || !body.data.ok) {
        const reason = body.success
          ? `${body.data.error_code ?? res.status}: ${body.data.description ?? "unknown error"}`
          : `HTTP ${res.status}`;
        await this.log.warn(`Telegram notification failed (${reason}).`);
      }
    } catch (err) {
      await this.log.warn(`Telegram notification error: ${String(err)}`);
    }
  }
}

/** Escape the characters significant to Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
