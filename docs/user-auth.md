# User authentication

Status: deployed to the dedicated validation Worker at `1fea429`. Hosted session/social mechanics passed on 2026-09-07 using temporary, explicitly synthetic operator fixtures; the later reprocessing proof also used real signed sessions on the current build. Existing dev/production remain unchanged. Real Discord/Twitch login and browser consent remain unverified: provider applications are not configured, and outbound calls remain disabled.

The Worker runs Better Auth with native D1 storage. Authentication management is limited to the documented `/api/auth/*` routes; `GET /api/v1/me` also returns the safe current identity. Application sessions use an HTTP-only, Secure, host-only cookie on HTTPS (`__Host-bazaarghost_session`), with SameSite=Lax and a fixed seven-day expiry. The browser sends `credentials: 'include'`; it never receives an admin, catalog, or processor key. Session responses contain application identity and a session-bound CSRF token, not the bearer session token or email.

Discord login requests `identify`, without email, bot installation, guild access, or messages. Twitch login validates the access token's client and user identity with Twitch and reads the corresponding Helix user. Provider access/refresh/ID tokens are discarded after identity verification. Synthetic internal addresses satisfy the library schema; the application does not collect an email address or send email.

## Dedicated validation setup

Use separate test OAuth applications. Keep existing production/dev callback registrations intact.

| Provider | Exact registered redirect URI | Worker secrets |
|---|---|---|
| Discord | `https://bazaarghost-validation.kaio-8df.workers.dev/api/auth/callback/discord` | `DISCORD_AUTH_CLIENT_ID`, `DISCORD_AUTH_CLIENT_SECRET` |
| Twitch | `https://bazaarghost-validation.kaio-8df.workers.dev/api/auth/callback/twitch` | `TWITCH_AUTH_CLIENT_ID`, `TWITCH_AUTH_CLIENT_SECRET` |

Set these secrets on **bazaarghost-validation** using the Cloudflare dashboard, or a reviewed `cf deploy --prebuilt --mode validation --secrets-file <PRIVATE_JSON_FILE>` deployment (see [tooling](tooling.md)). Do not paste secrets into chat or commit them. `AUTH_SECRET` is an independent randomly generated value of at least 32 characters for the environment. These credentials are distinct from the Discord bot and Twitch catalog credentials.

`AUTH_ENABLED` defaults to false for local/dev/production and is enabled in the dedicated validation configuration. Provider calls additionally require `OUTBOUND_ENABLED=true` and actual provider credentials; an enabled module with no configured providers cannot initiate login. Enabling login does not itself create ingestion schedules. `PUBLIC_URL` must be the exact backend origin, and trusted browser origins come from it plus `CORS_ORIGINS`. Hosted origins require HTTPS. The validation config currently trusts only its own HTTPS origin. A future separate browser frontend must use an explicitly reviewed origin and cookie-compatible deployment; cross-site third-party-cookie restrictions are not solved by CORS alone.

OAuth state is bound to its original browser, provider, and, for linking, its original fresh session. A separate D1 record atomically consumes each state before provider calls. Application database constraints check account/session consistency and revocation during native D1 writes. Failed registration recovery removes only identities created by that failed attempt that never acquired an account or session.

## Browser-facing API

| Method and route under `/api/auth` | Contract |
|---|---|
| `GET /providers` | Enabled state and configured provider names |
| `POST /sign-in/social` | JSON `{provider, callbackURL?}`; returns authorization URL and sets browser state cookie |
| `GET /callback/discord`, `/callback/twitch` | Provider redirect only; verifies/consumes state, creates session, redirects to the allowed callback URL |
| `GET /session` | Safe user/session identity and `csrfToken`; rejects absent, expired, or revoked sessions |
| `GET /accounts` | The signed-in user's linked identities |
| `GET /sessions` | The signed-in user's live sessions, excluding bearer tokens |
| `POST /link-social` | Explicitly link another provider to the current account; fresh login and CSRF required |
| `POST /unlink-account` | `{accountId}` for the caller's linked-account record; cannot remove the final identity; revokes other sessions |
| `POST /revoke-session` | `{sessionId}` for the caller's session |
| `POST /sign-out` | Revoke the current session and clear its cookie |
| `POST /sign-out-all` | Revoke all caller sessions and clear the current cookie |
| `POST /delete-account` | Remove caller identity, linked accounts, sessions, and owned social records through cascades |

All POSTs require JSON and an exact trusted `Origin`. Signed-in mutations additionally require `X-CSRF-Token` from `/session`. Linking, unlinking, deletion, revoking sessions, and signing out all sessions require a login from the last five minutes. Ordinary sign-out remains available for an older valid session. Implicit account merging by email is disabled. OAuth/account endpoints and errors are not cached.

Authentication request limits use bounded, expiring D1 counters keyed by a secret-derived IP hash; raw IPs are not persisted. The `* * * * *` Cron runs auth maintenance every minute, including while outbound integrations are disabled. Each invocation removes at most 500 expired rows per private auth table and 100 aged, never-registered orphan users. Live state and previously registered users are preserved. Session expiry is enforced on requests independently of this physical cleanup. One aggregate `auth_cleanup` log reports direct deletions, D1 rows read/written (including cascade/index work), and duration without private identifiers. This cadence correction has local and hosted acceptance evidence, tracked in [backend-validation-status.md](backend-validation-status.md). OAuth failures at `/api/auth/error` have a generic response; upstream error descriptions are removed from that redirect URL.

## Verification and remaining acceptance

The hosted mechanics smoke passed against exact build `1c5428c68ca035bab24b43fef1a34820435a8608` at `https://bazaarghost-validation.kaio-8df.workers.dev`, from 18:09:56 to 18:10:22 UTC on 2026-09-07. An operator inserted two unmistakably synthetic users/accounts and fourteen-minute sessions into the isolated D1 database, then signed their cookies with Better Auth's installed Better Call helper. Real HTTP requests verified safe identity/account/session reads, forged-cookie rejection, credentialed CORS, CSRF rejection, cross-user versus own-session revocation, exact cookie expiry, social ownership, and account-deletion cascades. The Worker did not expose a fixture-login endpoint, and no provider endpoint was called.

Final database checks found zero fixture users, accounts, sessions, or owned social rows. The existing clip and screenshot used for moderation were restored unchanged; see [clip-api.md](clip-api.md#verification). Private local evidence is `.ignore/platform-validation/hosted-social-smoke.6dfcb900-8bb2-4c85-8f5f-7c8e29409973/proof.json`. This is server HTTP/session evidence: it does not establish that a browser accepted the cookie or completed provider consent.

Local native-D1 tests additionally cover mocked provider callbacks, state replay/provider/browser binding, account collisions, explicit linking, concurrent registration/unlinking, suspension and revocation during callbacks, fresh/expired session boundaries, and bounded cleanup. The next acceptance checks are:

| Check | Passing result |
|---|---|
| Real Discord and Twitch browser consent, then repeat login | Each provider returns to its exact registered validation callback; the browser accepts the exact `__Host-` cookies; `/api/v1/me` succeeds; repeat login retains the same application user; provider grant columns remain null. Cancelled consent returns the generic error destination without creating a user. |
| Explicit linking with two disposable provider identities | Linking adds the second identity to the current user; signing in through either returns that user. Linking an identity already owned by another user fails without moving it. Unlinking keeps at least one identity and revokes other sessions. |
| Browser session lifecycle and intended frontend origin | Two browser sessions demonstrate current-session logout versus all-session logout. After five minutes, sensitive actions require new login; ordinary sign-out still works. Cookies, CSRF, and CORS work from the actual chosen application origin, including browsers that restrict third-party cookies. |
| Hosted expiry and scheduled cleanup | Hosted natural expiry passed: a previously valid session returns 401 for reads and CSRF-valid writes without changing mutation state. Five untouched expired witnesses disappeared during the hourly cleanup window while live/fresh/registered controls remained unchanged, but the observer did not capture its required event, so scheduled attribution remains incomplete. The newer minute cadence has now passed a separate actual scheduled check: consecutive events preserved an initially live counter and then removed it after expiry, with matching direct-deletion metrics and a future control unchanged. Both test counters were removed afterward. Hosted suspension, immediate revocation, and reactivation without session revival already passed in the expanded social proof. |

Provider acceptance needs dedicated OAuth credentials and user consent before enabling outbound calls. `OUTBOUND_ENABLED` is shared with other external integrations, so its validation configuration and pending work must be reviewed as part of that setup. No frontend user interface, provider logout synchronization, password login, or email recovery is implemented. Already-issued application sessions are managed through the application's revocation/logout controls; discarding provider tokens does not make provider logout revoke them automatically.
