# Incident Report — Copier Resume Button Locked After Settings Reset (2026-09-02)

## Summary

On 2 September 2026, user Stephen Furr Jr reported that after switching to a
new test account and turning the copier off to reset settings, the resume
button became permanently disabled. The button displayed "Copier Stopped" in
red with no clickable action. The user had no way to restart the copier from
the interface.

The root cause was that the new test account had no connected broker account,
which is one of four preconditions the system checks before allowing the
copier to start. When this precondition fails, the button is disabled with
no UI path to resolve the missing setup step.

## What actually happened

The copier toggle button in the dashboard header checks four conditions
before it allows the user to turn the copier on:

1. Active subscription
2. At least one broker with `connection_status = 'connected'`
3. A Telegram session
4. At least one active channel

If any of these is false, the button enters a "locked stopped" state: it
renders as a disabled red button with the label "Copier Stopped" and a
tooltip hint. Clicking it does nothing.

Stephen switched to a new test account. Freshly added broker accounts
typically start with `connection_status = 'pending'` until the worker
connects, or `'error'` if the terminal is offline. If his previously
connected account was deactivated during the reset, or the new account had
not yet connected, then the "has connected broker" check returned false.
This locked the button.

The only user-facing indication was a tooltip reading "Connect Telegram,
add channels, and link a broker to start the copier." There was no button
or link to navigate to the setup page. The user was stuck.

The pause flag itself (`copier_paused`) was not the cause. That flag only
gates the worker's signal execution. The lock was entirely in the
frontend precondition check.

## What we changed

One fix was applied to the copier toggle component:

When the button is locked for the "setup" reason (missing broker, Telegram
session, or channels), it now renders as a clickable link to the broker
configuration page (`/brokers`) instead of a disabled button. The link
is styled in amber with the label "Fix setup" to distinguish it from the
normal paused state.

The subscription-blocked case still shows the disabled red button, since
resolving a missing subscription requires a different flow (subscribe or
update payment).

## Verification

The code compiles cleanly with zero TypeScript errors. Lint passes with
zero new errors on the changed file. Pre-existing lint warnings in other
files are unchanged.

## Deployment

The fix is committed locally on the `staging` branch. It has not been
pushed or deployed. It should go to staging first, then to production
after validation.

## Follow-ups

- For Stephen specifically: verify his `broker_accounts` row in the
  production database. Confirm whether `is_active = true` and
  `connection_status = 'connected'`. If not, that is the missing
  precondition he needs to fix.
- Consider surfacing the specific missing precondition in the hint
  (e.g. "No connected broker account" versus a generic message).
- The same locked state applies when the user has no subscription.
  That path still shows the disabled red button. Consider whether
  it should also link to the billing page.

## Bottom line

A missing broker connection on a new test account locked the copier
resume button with no way to fix it from the interface. The fix makes
the button link directly to the broker setup page when the lock is
caused by an incomplete setup, so the user can resolve the issue
without contacting support.
