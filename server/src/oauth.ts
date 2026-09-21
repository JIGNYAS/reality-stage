/**
 * OAuth 2.0 for the Google Health API, using the loopback + PKCE flow.
 *
 * Google's own CLI registers as a "Desktop app" client, and so do we. That
 * matters: a Desktop client's "secret" is not actually a secret (it ships in
 * the binary), Google knows this, and the flow is hardened with PKCE instead.
 * The payoff is that we get refresh tokens, which a browser-only SPA client
 * cannot obtain.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { CLIENT_SECRET_PATH, TOKENS_PATH } from "./config.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Refresh this many ms before actual expiry, to avoid racing the clock. */
const EXPIRY_SKEW_MS = 60_000;

type ClientSecretFile = {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
};

type StoredTokens = {
  access_token: string;
  refresh_token: string;
  /** Epoch ms. */
  expires_at: number;
  scope: string;
};

export class AuthError extends Error {
  readonly steps: string[];
  constructor(message: string, steps: string[] = []) {
    super(message);
    this.name = "AuthError";
    this.steps = steps;
  }
}

const SETUP_STEPS = [
  "Open https://console.cloud.google.com/apis/credentials",
  "Create or select a Google Cloud project",
  "Enable the Google Health API: https://console.cloud.google.com/apis/api/health.googleapis.com",
  "Create an OAuth client ID with Application type: Desktop app",
  "Add yourself as a Test user under the OAuth consent screen",
  `Download the client secret JSON to ${CLIENT_SECRET_PATH}`,
];

async function loadClientSecret(): Promise<{ clientId: string; clientSecret: string }> {
  let raw: string;
  try {
    raw = await readFile(CLIENT_SECRET_PATH, "utf8");
  } catch {
    throw new AuthError(`No OAuth client secret found at ${CLIENT_SECRET_PATH}`, SETUP_STEPS);
  }
  const parsed = JSON.parse(raw) as ClientSecretFile;
  const creds = parsed.installed ?? parsed.web;
  if (!creds?.client_id || !creds.client_secret) {
    throw new AuthError(
      `${CLIENT_SECRET_PATH} is not a Google OAuth client secret file (no "installed" or "web" key).`,
      SETUP_STEPS,
    );
  }
  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Runs the full interactive consent flow and persists the resulting tokens.
 * Resolves once the browser has been redirected back to our loopback listener.
 */
export async function login(scopes: string[]): Promise<void> {
  const { clientId, clientSecret } = await loadClientSecret();

  const codeVerifier = base64url(randomBytes(64));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = base64url(randomBytes(32));

  const { code, redirectUri } = await awaitAuthorizationCode({
    clientId,
    scopes,
    codeChallenge,
    state,
  });

  const tokens = await exchange({
    clientId,
    clientSecret,
    body: {
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    },
  });

  if (!tokens.refresh_token) {
    throw new AuthError(
      "Google did not return a refresh token. Revoke this app's access at " +
        "https://myaccount.google.com/permissions and log in again.",
    );
  }
  await saveTokens({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope ?? scopes.join(" "),
  });
}

/**
 * Starts a loopback listener on an ephemeral port, prints the consent URL, and
 * resolves with the authorization code Google redirects back with.
 */
function awaitAuthorizationCode(opts: {
  clientId: string;
  scopes: string[];
  codeChallenge: string;
  state: string;
}): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }

      const respond = (status: number, message: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>fitbit-lab</title>` +
            `<body style="font:16px/1.5 system-ui;padding:3rem;max-width:34rem;margin:auto">` +
            `<h1 style="font-size:1.25rem">${message}</h1>` +
            `<p style="color:#666">You can close this tab and return to the terminal.</p></body>`,
        );
      };

      const error = url.searchParams.get("error");
      if (error) {
        respond(400, `Authorization failed: ${escapeHtml(error)}`);
        close();
        reject(new AuthError(`Authorization was denied: ${error}`));
        return;
      }

      const returnedState = url.searchParams.get("state") ?? "";
      if (!safeEqual(returnedState, opts.state)) {
        respond(400, "State mismatch - request rejected.");
        close();
        reject(new AuthError("OAuth state mismatch; possible CSRF. Try again."));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        respond(400, "No authorization code in the callback.");
        close();
        reject(new AuthError("Callback carried no authorization code."));
        return;
      }

      respond(200, "Connected. fitbit-lab now has read access to your health data.");
      close();
      resolve({ code, redirectUri });
    });

    let redirectUri = "";
    const close = () => {
      // Let the response flush before tearing the socket down.
      setTimeout(() => server.close(), 100);
    };

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      redirectUri = `http://127.0.0.1:${port}/callback`;

      const authUrl = new URL(AUTH_URL);
      authUrl.searchParams.set("client_id", opts.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", opts.scopes.join(" "));
      authUrl.searchParams.set("code_challenge", opts.codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", opts.state);
      // access_type=offline + prompt=consent is what makes Google hand back a
      // refresh token. Without prompt=consent it is issued only on the very
      // first authorization, so re-running login would silently yield none.
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");

      console.log("\nOpen this URL to authorize:\n");
      console.log(authUrl.toString());
      console.log("\nWaiting for the callback...");
    });
  });
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

async function exchange(opts: {
  clientId: string;
  clientSecret: string;
  body: Record<string, string>;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    ...opts.body,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AuthError(`Token endpoint returned ${res.status}: ${text}`);
  }
  return JSON.parse(text) as TokenResponse;
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await mkdir(dirname(TOKENS_PATH), { recursive: true });
  // 0600: these grant read access to your health history.
  await writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function readTokens(): Promise<StoredTokens | null> {
  try {
    return JSON.parse(await readFile(TOKENS_PATH, "utf8")) as StoredTokens;
  } catch {
    return null;
  }
}

/** True if tokens exist on disk, without validating them against Google. */
export async function isLoggedIn(): Promise<boolean> {
  return (await readTokens()) !== null;
}

export async function grantedScopes(): Promise<string[]> {
  const tokens = await readTokens();
  return tokens ? tokens.scope.split(" ").filter(Boolean) : [];
}

/**
 * Returns a valid access token, refreshing it if it is expired or close to it.
 * Refreshes are serialized so concurrent callers cannot stampede the endpoint.
 */
let inFlightRefresh: Promise<string> | null = null;

export async function accessToken(): Promise<string> {
  const tokens = await readTokens();
  if (!tokens) {
    throw new AuthError("Not logged in. Run `pnpm login` first.", SETUP_STEPS);
  }
  if (Date.now() < tokens.expires_at - EXPIRY_SKEW_MS) {
    return tokens.access_token;
  }
  inFlightRefresh ??= refresh(tokens).finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function refresh(tokens: StoredTokens): Promise<string> {
  const { clientId, clientSecret } = await loadClientSecret();
  let refreshed: TokenResponse;
  try {
    refreshed = await exchange({
      clientId,
      clientSecret,
      body: { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
    });
  } catch (err) {
    throw new AuthError(
      `Could not refresh the access token (${(err as Error).message}). ` +
        "The grant may have been revoked - run `pnpm login` again.",
    );
  }
  await saveTokens({
    ...tokens,
    access_token: refreshed.access_token,
    expires_at: Date.now() + refreshed.expires_in * 1000,
    // Google usually omits refresh_token on refresh; keep the existing one.
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    scope: refreshed.scope ?? tokens.scope,
  });
  return refreshed.access_token;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
