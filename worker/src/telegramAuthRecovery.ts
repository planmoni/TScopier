/**
 * Telegram phone/QR auth error classification for AuthService.
 * Recoverable errors must keep the pending MTProto client so the user can retry
 * (especially wrong 2FA password) without restarting send_code.
 */

export function isRecoverableTelegramAuthError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (!m.trim()) return false

  // Wrong / missing 2FA — user should retry the same pending session.
  if (
    m.includes('password_hash_invalid')
    || m.includes('password_hash_empty')
    || m.includes('srp_password_changed')
    || m.includes('two-step verification password is required')
    || (m.includes('password') && (m.includes('invalid') || m.includes('incorrect') || m.includes('wrong')))
  ) {
    return true
  }

  // A wrong app/SMS code — Telegram keeps the phoneCodeHash valid across
  // retries, so one typo must NOT destroy the whole pending auth. Previously
  // PHONE_CODE_INVALID was classified fatal, forcing a full send_code restart
  // (and, combined with stale-code invalidation, repeated 5-digit-code failures).
  if (m.includes('phone_code_invalid')) {
    return true
  }

  // Transient Telegram / network issues during verify.
  if (
    m.includes('timeout')
    || m.includes('timed out')
    || m.includes('network')
    || m.includes('econnreset')
    || m.includes('socket')
    || m.includes('temporarily unavailable')
    || m.includes('cannot send requests while disconnected')
  ) {
    return true
  }

  return false
}

/** Errors that mean the SMS/app code itself is dead — must call send_code again. */
export function isPhoneCodeFatalAuthError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err ?? '')).toUpperCase()
  return (
    m.includes('PHONE_CODE_EXPIRED')
    || m.includes('PHONE_NUMBER_INVALID')
    || m.includes('PHONE_CODE_EMPTY')
  )
}

export const NO_PENDING_PHONE_AUTH_ERROR = 'NO_PENDING_PHONE_AUTH' as const

export function noPendingPhoneAuthMessage(): string {
  return 'Login session expired. Go back and request a new verification code.'
}
