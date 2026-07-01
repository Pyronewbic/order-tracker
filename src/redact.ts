/** A function that masks every known secret value it finds in a string. */
export type Redactor = (text: string) => string;

const MASK = "***REDACTED***";

// Secrets shorter than this are too generic to mask safely — blanking a 3-char
// string would corrupt unrelated log text. Real tokens (OAuth refresh tokens,
// API keys, bot tokens) are all comfortably longer.
const MIN_SECRET_LEN = 8;

/**
 * Build a {@link Redactor} from a set of known secret values (client secret,
 * refresh tokens, Notion key, Telegram bot token, Anthropic key). The returned
 * function replaces every occurrence of any secret with a fixed mask, so a
 * stack trace or upstream API error can never carry a live credential into
 * `tracker.log` or a Telegram message.
 *
 * Matching is literal (split/join, not RegExp) to avoid both regex-escaping
 * pitfalls and ReDoS on attacker-influenced log content. Secrets are masked
 * longest-first so an embedded shorter secret can't leave a tail unmasked.
 */
export function makeRedactor(secrets: (string | undefined | null)[]): Redactor {
  const unique = [
    ...new Set(
      secrets.filter(
        (s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LEN,
      ),
    ),
  ].sort((a, b) => b.length - a.length);

  if (unique.length === 0) return (text) => text;

  return (text) => {
    let out = text;
    for (const secret of unique) out = out.split(secret).join(MASK);
    return out;
  };
}
