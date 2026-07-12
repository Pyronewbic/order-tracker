import { google, type gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** A flattened, decoded Gmail message with just the fields we care about. */
export interface ParsedMessage {
  id: string;
  /** Epoch milliseconds the message was received (Gmail `internalDate`). */
  internalDateMs: number;
  subject: string;
  from: string;
  snippet: string;
  /** Decoded text body (plain text preferred, HTML stripped as fallback). */
  body: string;
}

/** Builds an OAuth2 client seeded with a long-lived refresh token. */
export function makeOAuthClient(creds: GmailCredentials): OAuth2Client {
  const client = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
  client.setCredentials({ refresh_token: creds.refreshToken });
  return client;
}

export class GmailClient {
  private readonly gmail: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: "v1", auth });
  }

  /**
   * List message IDs matching `query`. When `afterEpochSec` is provided an
   * `after:` clause is appended so only newer mail is returned.
   */
  async listMessageIds(query: string, afterEpochSec?: number): Promise<string[]> {
    const q = afterEpochSec !== undefined ? `${query} after:${afterEpochSec}` : query;
    const ids: string[] = [];
    let pageToken: string | undefined;

    do {
      const res = await this.gmail.users.messages.list({
        userId: "me",
        q,
        pageToken,
        maxResults: 100,
      });
      for (const m of res.data.messages ?? []) {
        if (m.id) ids.push(m.id);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return ids;
  }

  /** Fetch and decode a single message into a {@link ParsedMessage}. */
  async getMessage(id: string): Promise<ParsedMessage> {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    const msg = res.data;
    const headers = msg.payload?.headers ?? [];

    const header = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    return {
      id,
      internalDateMs: Number(msg.internalDate ?? 0),
      subject: header("Subject"),
      from: header("From"),
      snippet: msg.snippet ?? "",
      body: extractBody(msg.payload),
    };
  }
}

/** Recursively walk a MIME tree and return the best available text body. */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  const plain = findPart(payload, "text/plain");
  if (plain) return decodeBase64Url(plain);

  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodeBase64Url(html));

  return "";
}

function findPart(part: gmail_v1.Schema$MessagePart, mime: string): string | undefined {
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return undefined;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
