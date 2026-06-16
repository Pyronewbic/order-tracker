import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { google } from "googleapis";
import { loadConfig } from "./config.js";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const ENV_PATH = ".env";

/**
 * One-time interactive OAuth flow. Spins up a loopback server, sends you to
 * Google's consent screen, captures the authorization code, exchanges it for a
 * refresh token, and writes that token back into `.env`.
 *
 * Requires GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET from a Google Cloud "Desktop
 * app" OAuth client, whose loopback redirect (http://localhost:PORT) needs no
 * pre-registration.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
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

  const code = await waitForCode(authUrl, port);
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke prior access at " +
        "https://myaccount.google.com/permissions and run `npm run auth` again.",
    );
  }

  await upsertEnv("GMAIL_REFRESH_TOKEN", tokens.refresh_token);
  console.log("\n✓ Refresh token saved to .env (GMAIL_REFRESH_TOKEN).");
  console.log("  You can now run `npm start`.");
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

/** Insert or replace a single KEY=value line in the .env file. */
async function upsertEnv(key: string, value: string): Promise<void> {
  let contents = "";
  try {
    contents = await readFile(ENV_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(contents)
    ? contents.replace(re, line)
    : (contents.endsWith("\n") || contents === "" ? contents : contents + "\n") +
      line +
      "\n";

  await writeFile(ENV_PATH, next);
}

main().catch((err) => {
  console.error(`\n[auth] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
