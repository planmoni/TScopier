import { describe, expect, it } from 'vitest'
import { MIN_RESEND_COOLDOWN_MS, resolveResendAvailableAt } from './telegramAuthApi'

describe('resolveResendAvailableAt', () => {
  it('keeps the server-provided resend window when one exists', () => {
    const at = new Date(Date.now() + 45_000).toISOString()
    expect(resolveResendAvailableAt({ resend_available_at: at })).toBe(at)
  })

  it('falls back to a 30s window when the worker gives no resend_available_at and no real resend path (app-only delivery)', () => {
    const before = Date.now()
    const resolved = resolveResendAvailableAt({ resend_available_at: null, can_resend: false, next_delivery: null })
    const after = Date.now()
    expect(resolved).not.toBeNull()
    const ms = new Date(resolved as string).getTime()
    expect(ms).toBeGreaterThanOrEqual(before + MIN_RESEND_COOLDOWN_MS - 50)
    expect(ms).toBeLessThanOrEqual(after + MIN_RESEND_COOLDOWN_MS + 50)
  })

  it('returns null when can_resend is true but no server window is present (resend ready now)', () => {
    expect(resolveResendAvailableAt({ resend_available_at: null, can_resend: true, next_delivery: 'sms' })).toBeNull()
  })
})
