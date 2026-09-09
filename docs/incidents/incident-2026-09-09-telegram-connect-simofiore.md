# Incident: User could not connect Telegram — wedged listener after key revocation

- **Date:** 2026-09-09
- **Status:** Mitigated — fix awaiting deploy
- **Severity:** Medium
- **Affected user:** `simofiore16321@gmail.com` (Supabase `8491f3f9-ee04-4870-bb93-05fb4bccb856`)
- **Component:** prod listener worker — `worker/src/sessionManager.ts`, `worker/src/userListener.ts` (deployment `0a560378`, built 2026-09-04)
- **Rendered report:** `docs/incidents/incident-2026-09-09-telegram-connect-simofiore.pdf` (source HTML: same basename `.html`)

## Plain English

The user linked her Telegram on 2026-09-08 05:41 UTC and copied signals normally for ~5h. At
10:58 UTC Telegram revoked her login's security key (nothing she did — no duplicate or conflict on
our side). The system then got stuck: the production worker kept a half-dead listener alive and
"flapping" every ~20s, and because a known reconnect bug (fixed in code but not yet deployed) was
still live, it could neither reconnect her nor be cleanly stopped. Every recovery attempt she made —
Reconnect, Send a new code, QR login — timed out after ~90s. Around 09-09 07:14 UTC the stuck
process cleared itself; her lease expired and no listener remains, so she can link again with a
fresh login. The permanent fix is still waiting to deploy to production.

## Root cause

1. **Trigger (user-specific):** Telegram revoked her auth key at 2026-09-08 10:58:27
   (`401 AUTH_KEY_UNREGISTERED`), isolated to her; no `AUTH_KEY_DUPLICATED` and no other
   worker/replica touched the session.
2. **Why she couldn't recover (pre-fix worker bugs):**
   - `sessionManager.ts` — `disconnectedRenewTicks` heal counter deleted every renew tick, so the
     ~60s hard-restart escape hatch never fired (Bug A).
   - `userListener.ts` — `forceReconnect` connect had no timeout and `stop()` awaited the in-flight
     reconnect forever, wedging reconnect + stop; lease renewed indefinitely, blocking handoff
     (Bug B).

## Timeline (UTC)

- 09-08 05:37 signup; 05:40–05:41 phone-code link OK (Telegram user 7480332791, +39…, 20 channels).
- 05:41–10:58 connected/healthy; signal dispatched 06:01.
- 10:58:27 AUTH_KEY_UNREGISTERED; 10:59:09 force reconnect → malformed RPC → never reconnects.
- 10:59:23 flapping begins (~20s) for 20+ hours.
- 12:44 health frozen `listener_stop_requested`; 12:45/46/50 Reconnect attempts hang at "stopping listener (attempt 1/4)".
- 22:48 Send a new code → AUTH_OPERATION_TIMEOUT; QR 09-09 06:40 also times out.
- ~09-09 07:13–07:14 flapping stops, lease expires; worker alive serving others; state clean.

## Current DB state

- `telegram_sessions`: empty · `telegram_auth_pending`: empty
- `worker_session_leases`: expired 09-09 07:14:22 (not renewed)
- `telegram_account_claims`: **intact** (7480332791) → re-link without conflict

## Fix / follow-up

- Immediate: restart `TScopier - Listener` (production) to clear residual wedged listeners; user can
  re-link now.
- Permanent: deploy reconnect-storm fix `1ecb9e47` (staging) to production; then watch the 09-07/08
  affected users (`af75b63e`, `30c3fa79`, `494bdb70`, `dd18ad68`, `995e7936`, `7fd2f7b4`,
  `8491f3f9`) for a clean reconnect.
