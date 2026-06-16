import http from "node:http";
import { readFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { google } from "googleapis";
import { loadAuthConfig } from "./config.js";
import { writeFileAtomic } from "./fsutil.js";

// Read-only is the least-privilege scope that still exposes message bodies (the
// parser needs subject + body for status/tracking/amount). Gmail has no
// per-label OAuth scope, and we deliberately never request a send/modify scope.
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// Labels become JSON keys and appear in logs; keep them to a safe character set.
const LABEL_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * One-time interactive OAuth flow for a single account. Spins up a loopback
 * server, sends you to Google's consent screen, captures the authorization
 * code, exchanges it for a refresh token, and stores that token under the given
 * label in `accounts.json`.
 *
 * Usage:
 *   npm run auth -- <label>     authorize one inbox (e.g. `npm run auth -- work`)
 *   npm run auth -- --list      list configured labels (also `npm run accounts`)
 *
 * Requires GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET from a Google Cloud "Desktop
 * app" OAuth client, whose loopback redirect (http://localhost:PORT) needs no
 * pre-registration. The same OAuth app is shared across all accounts; pick the
 * intended Google account in the browser chooser each time.
 */
async function main(): Promise<void> {
  const cfg = loadAuthConfig();
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const wantList = args.includes("--list");
  const label = args.find((a) => !a.startsWith("-"));

  if (wantList) {
    await listAccounts(cfg.ACCOUNTS_FILE);
    return;
  }

  if (!label) {
    throw new Error(
      "Missing account label. Usage: `npm run auth -- <label>` " +
        "(or `npm run accounts` to list configured labels).",
    );
  }
  if (!LABEL_RE.test(label)) {
    throw new Error(
      `Invalid label "${label}". Use letters, digits, "_", "-", "." only.`,
    );
  }

  const port = cfg.OAUTH_REDIRECT_PORT;
  const redirectUri = `http://localhost:${port}`;

  const oauth2 = new google.auth.OAuth2(
    cfg.GMAIL_CLIENT_ID,
    cfg.GMAIL_CLIENT_SECRET,
    redirectUri,
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-auth
    scope: SCOPES,
  });

  console.log(`\nAuthorizing account "${label}".`);
  console.log("In the browser chooser, pick the Google account you intend to link.");

  const code = await waitForCode(authUrl, port);
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke prior access at " +
        "https://myaccount.google.com/permissions and run the command again.",
    );
  }

  await upsertAccount(cfg.ACCOUNTS_FILE, label, tokens.refresh_token);
  console.log(`\n✓ Saved refresh token for "${label}" to ${cfg.ACCOUNTS_FILE}.`);
  console.log("  Run `npm run accounts` to see all configured accounts, or `npm start`.");
}

/** Print the configured account labels (no tokens). */
async function listAccounts(file: string): Promise<void> {
  const accounts = await readAccounts(file);
  const labels = Object.keys(accounts);
  if (labels.length === 0) {
    console.log(`No accounts configured. Run \`npm run auth -- <label>\` to add one.`);
    return;
  }
  console.log(`Configured accounts (${labels.length}):`);
  for (const label of labels) console.log(`  - ${label}`);
}

/** Open a loopback server, prompt the user, and resolve with the auth code. */
function waitForCode(authUrl: string, port: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "", `http://localhost:${port}`);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.end(`Authorization failed: ${error}. You can close this tab.`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (!code) {
          res.statusCode = 400;
          res.end("Missing authorization code.");
          return;
        }

        res.end("Authorization complete. You can close this tab and return to the terminal.");
        server.close();
        resolve(code);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.on("error", reject);
    server.listen(port, () => {
      const actual = (server.address() as AddressInfo).port;
      console.log("\nOpen this URL in your browser to authorize Gmail access:\n");
      console.log(`  ${authUrl}\n`);
      console.log(`Waiting for the redirect on http://localhost:${actual} ...`);
    });
  });
}

/** Read + validate `accounts.json`, returning `{}` when the file is absent. */
async function readAccounts(file: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Object.values(parsed).some((v) => typeof v !== "string" || v.length === 0)
  ) {
    throw new Error(
      `Existing ${file} is not a { "<label>": "<token>" } object; fix or remove it first.`,
    );
  }
  return parsed as Record<string, string>;
}

/** Insert or replace one label's token, writing the file atomically at 0600. */
async function upsertAccount(
  file: string,
  label: string,
  refreshToken: string,
): Promise<void> {
  const accounts = await readAccounts(file);
  accounts[label] = refreshToken;
  await writeFileAtomic(file, JSON.stringify(accounts, null, 2));
}

main().catch((err) => {
  console.error(`\n[auth] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
