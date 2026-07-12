import { z } from "zod";
import type { Logger } from "../logger.js";
import type { Redactor } from "../redact.js";
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
    source?: string,
  ): Promise<void>;
  /** Send a free-form operational message (startup, errors). Never throws. */
  notify(text: string): Promise<void>;
}

export const STATUS_EMOJI: Record<OrderStatus, string> = {
  Ordered: "🧾",
  "In Transit": "📦",
  Delayed: "⏳",
  "Arriving Soon": "🚚",
  Delivered: "✅",
  Cancelled: "❌",
  Returned: "↩️",
};

/**
 * Build a {@link Notifier}. Returns a {@link DryRunNotifier} when `DRY_RUN` is
 * set (logs instead of sending), a no-op notifier when Telegram is unconfigured,
 * or a live {@link TelegramNotifier} otherwise — so callers never branch on it.
 */
export function createNotifier(
  cfg: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; DRY_RUN?: boolean },
  log: Logger,
  redact?: Redactor,
): Notifier {
  if (cfg.DRY_RUN) return new DryRunNotifier(log);
  if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHAT_ID) {
    return new NoopNotifier();
  }
  return new TelegramNotifier(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID, log, redact);
}

class NoopNotifier implements Notifier {
  async notifyStatusChange(): Promise<void> {}
  async notify(): Promise<void> {}
}

/** Logs what it *would* have sent instead of calling Telegram (DRY_RUN). */
class DryRunNotifier implements Notifier {
  constructor(private readonly log: Logger) {}

  async notifyStatusChange(
    book: string,
    status: OrderStatus,
    detail: string,
    source?: string,
  ): Promise<void> {
    const prefix = source ? `[${source}] ` : "";
    await this.log.info(
      `[dry-run] would notify: ${prefix}${book} → ${status} (${detail})`,
    );
  }

  async notify(text: string): Promise<void> {
    await this.log.info(`[dry-run] would notify: ${text.replace(/\n/g, " ")}`);
  }
}

export class TelegramNotifier implements Notifier {
  private readonly redact: Redactor;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly log: Logger,
    redact?: Redactor,
  ) {
    this.redact = redact ?? ((s) => s);
  }

  async notifyStatusChange(
    book: string,
    status: OrderStatus,
    detail: string,
    source?: string,
  ): Promise<void> {
    const tag = source ? `<code>[${escapeHtml(source)}]</code> ` : "";
    const text =
      `${STATUS_EMOJI[status]} ${tag}<b>${escapeHtml(book)}</b>\n` +
      `Status: <b>${escapeHtml(status)}</b>\n` +
      `<i>${escapeHtml(detail)}</i>`;
    await this.notify(text);
  }

  /** POST to sendMessage. Logs and swallows errors — notifications are
   * best-effort and must never break the polling loop. The message is run
   * through the redactor first so an error string can't leak a token. */
  async notify(text: string): Promise<void> {
    const safe = this.redact(text);
    try {
      const res = await fetch(`${API_BASE}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: safe,
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
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
