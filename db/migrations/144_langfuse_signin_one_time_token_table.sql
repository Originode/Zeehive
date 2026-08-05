-- LANGFUSE ONE-TIME SIGNIN TOKEN — the second half of TKT-95 (stop handing out the
-- Langfuse admin password).
--
-- GET /api/langfuse/signin used to 302 the auto-login popup to the injected
-- zeehive-auto-login.html page with `?email=…&password=…` in the query string — the admin
-- credential rode in a URL (browser history, proxy logs, referrer chain) to any caller that
-- could reach the API. This migration adds the store for a short-lived ONE-TIME signin token
-- that the redirect carries INSTEAD of the credential: the redirect is now
-- `?token=<one-time>&redeem=<server-url>`, and the auto-login page redeems the token against
-- the ZEEHIVE server to obtain the credential once, server-side.
--
-- Security properties (matching lib/langfuse.js + routes.js):
--   * the table stores only the SHA-256 HASH of the token (never the plaintext) — the same
--     discipline as xell.self_token_hash / provider_tokens.
--   * single-use: redemption is `UPDATE … SET used_at=now() WHERE used_at IS NULL AND
--     expires_at > now() RETURNING *` — an atomic claim; a second redemption of the same
--     token matches no row.
--   * short TTL: minted at now() + 60s; expired rows are swept on every mint and never
--     redeemable.
--   * the post-login callback is stored WITH the token, so the redirect carries ONLY the
--     token + the redemption URL — `callback` (a Langfuse-origin URL, guarded against open
--     redirect by safeLangfuseCallback) is returned by the redemption, never placed in a URL.

CREATE TABLE IF NOT EXISTS langfuse_signin_token (
  token_hash  text PRIMARY KEY,          -- sha256 hex of the one-time token (never the plaintext)
  callback    text NOT NULL,             -- the safe post-login callback (safeNext || uiBase)
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,      -- now() + 60s — short TTL, swept on every mint
  used_at     timestamptz                -- set on first redemption; single-use via used_at IS NULL
);

CREATE INDEX IF NOT EXISTS langfuse_signin_token_expires_at_idx
  ON langfuse_signin_token (expires_at);
