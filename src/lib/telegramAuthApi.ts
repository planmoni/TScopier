import { resolveTelegramAuthError, TELEGRAM_ALREADY_LINKED_ERROR } from './telegramAuthError'

export type TelegramAuthAction =
  | 'send_code'
  | 'resend_code'
  | 'verify_code'
  | 'start_qr_login'
  | 'poll_qr_login'
  | 'verify_qr_password'
  | 'list_channels'
  | 'reconnect_telegram'
  | 'disconnect_telegram'
  | 'backfill_channel_history'

export type QrPollStatus = 'waiting' | 'requires_password' | 'success' | 'error'

export type QrPollResponse = {
  status: QrPollStatus
  qr_url?: string
  expires_at?: string
  requires_password?: boolean
  session_id?: string
  channels?: unknown[]
  error?: string
}

export type TelegramCodeDelivery = 'app' | 'sms' | 'call' | 'other'

export type TelegramCodeStatusResponse = {
  delivery?: TelegramCodeDelivery
  next_delivery?: TelegramCodeDelivery | null
  resend_available_at?: string | null
  resend_wait_seconds?: number | null
  can_resend?: boolean
  code_length?: number | null
}

// Minimum cooldown before "Send a new code" re-enables after a code is
// requested. The worker only returns a real resend_available_at when Telegram
// offers an SMS/call resend path; when the code is delivered to the app only,
// we still enforce this short floor so the button is never instantly clickable.
export const MIN_RESEND_COOLDOWN_MS = 30_000

// Resolve the resend-availability window to pass to the connect flow. When the
// worker gives none and there is no real resend path (app-only delivery), fall
// back to a fresh 30s window so the countdown shows and the button is blocked
// right after a code is requested. When the worker gives a real window (SMS/call
// next delivery) or when the code was just requested via app-only, the server
// value always wins — we only impose the floor on the app-only no-resend branch.
export function resolveResendAvailableAt(data: TelegramCodeStatusResponse): string | null {
  if (data.resend_available_at) return data.resend_available_at
  if (!data.can_resend) return new Date(Date.now() + MIN_RESEND_COOLDOWN_MS).toISOString()
  return null
}

export type TelegramAuthErrorMessages = {
  telegramAlreadyLinked: string
  failedStartQr?: string
  noPendingQr?: string
  noPendingPhoneAuth?: string
}

export async function callTelegramAuth<T>(
  edgeFnUrl: string,
  accessToken: string | undefined,
  action: TelegramAuthAction,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(edgeFnUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, ...body }),
  })
  const data = await res.json().catch(() => ({})) as T & { error?: string }
  return { ok: res.ok && !data.error, status: res.status, data }
}

export function resolveTelegramAuthErrorMessage(
  error: unknown,
  fallback: string,
  messages: TelegramAuthErrorMessages,
): string {
  if (error === 'NO_PENDING_QR') {
    return messages.noPendingQr ?? 'QR login expired. Please start again.'
  }
  return resolveTelegramAuthError(error, fallback, messages)
}

export { TELEGRAM_ALREADY_LINKED_ERROR }
