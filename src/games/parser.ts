import type { ParsedMessage } from "../gmail/client.js";

/** Where a digital game was bought. */
export type GamePlatform = "eShop JP" | "eShop US" | "Amazon JP";

/** Lifecycle of a digital purchase. `Purchased` supersedes `Preordered`. */
export type GameStatus = "Preordered" | "Purchased";

/**
 * A parsed digital-game email. Digital games have no shipment; the lifecycle is
 * just preorder → purchase. A game is keyed by platform + title (so an order
 * confirmation and its later code-delivery mail, or a preorder and its eventual
 * purchase, collapse onto one row).
 */
export interface GameEvent {
  platform: GamePlatform;
  status: GameStatus;
  /** Cleaned game title. */
  title: string;
  /** Price as written ("3,960円", "￥4,000"), or undefined. */
  price?: string;
  /** Device line from eShop receipts ("Nintendo Switch 2"), or undefined. */
  device?: string;
  /** Epoch ms the email was received (the event time). */
  receivedMs: number;
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

// Strip the marketplace noise that clutters Amazon JP titles: the trailing
// "|オンラインコード版" (online-code edition) suffix and surrounding whitespace.
function cleanTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw
    .replace(/[|｜]\s*オンラインコード版.*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return t || undefined;
}

/** Any Japanese character — used to tell a JP eShop receipt from a US one. */
const HAS_JP = /[　-ヿ一-龯＀-￯]/;

// Not a game — excluded so the DB stays about actual games: wallet funding
// ("Funds Added", prepaid credit) and recurring services (Switch Online
// membership, Game Catalog tickets). One-line to re-include if ever wanted.
const FUNDING_SUBJECT = /funds added|adding funds/i;
const EXCLUDE_TITLE =
  /ニンテンドープリペイド|プリペイド番号|nintendo eshop card|prepaid|nintendo switch online|オンライン.+プラン|カタログチケット|catalog ticket|membership/i;

/**
 * Parse a digital-game email into a {@link GameEvent}, or null if it isn't a
 * purchase/preorder we track. Caller should pre-filter to the known senders;
 * this classifies content. Covers Amazon JP (order + code-delivery + preorder)
 * and Nintendo eShop (JP receipts/preorders, and English US receipts).
 */
export function parseGameEmail(msg: ParsedMessage): GameEvent | null {
  const from = msg.from.toLowerCase();
  const subject = msg.subject;
  const body = msg.body || msg.snippet;
  const receivedMs = msg.internalDateMs;

  const game = (
    platform: GamePlatform,
    status: GameStatus,
    title: string | undefined,
    extra: { price?: string; device?: string } = {},
  ): GameEvent | null => {
    if (!title || EXCLUDE_TITLE.test(title)) return null; // skip funding/services
    return { platform, status, title, receivedMs, ...extra };
  };

  // ── Amazon JP digital ────────────────────────────────────────────────────
  if (from.includes("@amazon.co.jp")) {
    // Preorder: お客様のAmazon.co.jpの予約注文「TITLE」
    const pre = cleanTitle(firstMatch(subject, [/予約注文「(.+?)」/]));
    if (pre) return game("Amazon JP", "Preordered", pre);
    // Code-delivery: "TITLE の引き換えコード…" (JP) or "Your redemption codes for TITLE are" (EN)
    const code = cleanTitle(
      firstMatch(subject, [/^(.+?)の引き換えコード/, /redemption codes? for\s+(.+?)\s+are/i]),
    );
    if (code) return game("Amazon JP", "Purchased", code);
    // Order confirmation: Amazon.co.jpでのご注文: TITLE
    const order = cleanTitle(firstMatch(subject, [/ご注文:\s*(.+)$/]));
    if (order) {
      const price = firstMatch(body, [/総計:\s*([￥¥]\s*[\d,]+)/, /税引前合計:\s*([￥¥]\s*[\d,]+)/])?.replace(/\s+/g, "");
      return game("Amazon JP", "Purchased", order, { price });
    }
    return null;
  }

  // ── Nintendo eShop (accounts.nintendo.com / ccg.nintendo.net) ─────────────
  if (from.includes("nintendo.com") || from.includes("nintendo.net")) {
    if (FUNDING_SUBJECT.test(subject)) return null; // wallet top-up, not a game
    const jp = HAS_JP.test(subject) || HAS_JP.test(body);
    const platform: GamePlatform = jp ? "eShop JP" : "eShop US";
    const device = firstMatch(body, [/(?:○デバイスタイプ|Device Type):\s*(Nintendo Switch(?:\s*2)?)/]);

    // Preorder: 【予約確認】TITLE の予約を承りました  (title also in body)
    if (/予約確認|pre-?order/i.test(subject)) {
      const title = cleanTitle(
        firstMatch(subject, [/【予約確認】\s*(.+?)\s*の予約を承りました/]) ??
          firstMatch(body, [/○お申込みいただいた商品:\s*(.+?)\s*○デバイスタイプ/]),
      );
      const price = firstMatch(body, [/金額:\s*([\d,]+円)/]);
      return game(platform, "Preordered", title, { price, device });
    }

    // Purchase receipt — JP: [ご利用明細]…○ご購入商品 ; US/EN: "Purchased Item:"
    if (/ご利用明細|商品のご購入|confirmation of digital purchase|receipt|thank you for your (purchase|order)/i.test(subject)) {
      const title = cleanTitle(
        firstMatch(body, [
          /○ご購入商品:\s*(.+?)\s*(?:○デバイスタイプ|お支払い|[-‑–]{3,})/,
          /Purchased Item:\s*(.+?)\s*(?:Purchased Membership|Device Type|[‑–-]{3,})/,
        ]),
      );
      const price = firstMatch(body, [/お支払い合計金額:\s*([\d,]+円)/, /Total:\s*(\$[\d.,]+)/]);
      return game(platform, "Purchased", title, { price, device });
    }
    return null;
  }

  return null;
}
