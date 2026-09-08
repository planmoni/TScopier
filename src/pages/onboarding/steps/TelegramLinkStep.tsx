import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useT } from '../../../context/LocaleContext'
import { resolveTelegramAuthError, isNoPendingPhoneAuthError } from '../../../lib/telegramAuthError'
import {
  callTelegramAuth,
  resolveTelegramAuthErrorMessage,
  type QrPollResponse,
  type TelegramCodeDelivery,
  type TelegramCodeStatusResponse,
} from '../../../lib/telegramAuthApi'
import { supabase } from '../../../lib/supabase'
import { Card } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { ShieldCheck } from 'lucide-react'
import {
  TelegramConnectFlow,
  type TelegramAuthMethod,
  type TelegramConnectStage,
} from '../../../components/telegram/TelegramConnectFlow'

interface Props {
  onDone: (sessionId: string) => void
}

const EDGE_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`

function normalizeTelegramPhoneInput(raw: string): string {
  const compact = String(raw ?? '').trim().replace(/[\s\-()]/g, '')
  if (compact.startsWith('00')) return `+${compact.slice(2)}`
  return compact
}

function normalizeTelegramCodeInput(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '')
}

export function TelegramLinkStep({ onDone }: Props) {
  const { session } = useAuth()
  const t = useT()
  const ce = t.copierEnginePage
  const [stage, setStage] = useState<TelegramConnectStage | 'confirm_2fa' | 'done'>('method')
  const [authMethod, setAuthMethod] = useState<TelegramAuthMethod>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [codeDelivery, setCodeDelivery] = useState<TelegramCodeDelivery | null>(null)
  const [nextCodeDelivery, setNextCodeDelivery] = useState<TelegramCodeDelivery | null>(null)
  const [resendAvailableAt, setResendAvailableAt] = useState<string | null>(null)
  const [canResendCode, setCanResendCode] = useState(false)
  const [password, setPassword] = useState('')
  const [qrUrl, setQrUrl] = useState('')
  const [qrWaiting, setQrWaiting] = useState(false)
  const [sessionRowId, setSessionRowId] = useState<string | null>(null)
  const [twoFaConfirmed, setTwoFaConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLinked = useCallback((sessionId: string) => {
    setSessionRowId(sessionId)
    setQrUrl('')
    setQrWaiting(false)
    setError('')
    setStage('confirm_2fa')
  }, [])

  const startQrLogin = useCallback(async () => {
    setError('')
    setLoading(true)
    setQrWaiting(true)
    try {
      const { ok, data } = await callTelegramAuth<{ qr_url?: string }>(
        EDGE_FN,
        session?.access_token,
        'start_qr_login',
        {},
      )
      if (!ok || !data.qr_url) {
        setQrWaiting(false)
        setError(resolveTelegramAuthErrorMessage(data.error, ce.failedStartQr, ce))
        return
      }
      setQrUrl(data.qr_url)
    } catch {
      setQrWaiting(false)
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [session?.access_token, ce])

  useEffect(() => {
    if (stage !== 'qr' || !session?.access_token || !qrUrl) return

    let cancelled = false
    const poll = async () => {
      try {
        const { ok, data } = await callTelegramAuth<QrPollResponse>(
          EDGE_FN,
          session.access_token,
          'poll_qr_login',
          {},
        )
        if (cancelled) return
        if (data.qr_url && data.qr_url !== qrUrl) setQrUrl(data.qr_url)
        if (data.status === 'requires_password' || data.requires_password) {
          setQrWaiting(false)
          setError('')
          setStage('twoFa')
          return
        }
        if (data.status === 'success' && data.session_id) {
          setQrWaiting(false)
          handleLinked(data.session_id)
          return
        }
        if (data.status === 'waiting') return
        if (data.status === 'error' || (!ok && data.error)) {
          if (data.error === 'NO_PENDING_QR' && session.user?.id) {
            const { data: sess } = await supabase
              .from('telegram_sessions')
              .select('id')
              .eq('user_id', session.user.id)
              .eq('is_active', true)
              .maybeSingle()
            if (cancelled) return
            if (sess?.id) {
              setQrWaiting(false)
              handleLinked(String(sess.id))
              return
            }
          }
          setQrWaiting(false)
          setError(resolveTelegramAuthErrorMessage(data.error, ce.failedStartQr, ce))
        }
      } catch {
        if (!cancelled) setError('Network error. Please try again.')
      }
    }

    void poll()
    const interval = setInterval(() => void poll(), 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll while QR URL is present
  }, [stage, session?.access_token, Boolean(qrUrl), handleLinked, ce.failedStartQr, ce])

  const requestCode = async () => {
    setError('')
    setLoading(true)
    try {
      const normalizedPhone = normalizeTelegramPhoneInput(phone)
      const { ok, data } = await callTelegramAuth<TelegramCodeStatusResponse>(
        EDGE_FN,
        session?.access_token,
        'send_code',
        { phone: normalizedPhone },
      )
      if (!ok) {
        setError(resolveTelegramAuthError(data.error, ce.failedSendCode, ce))
        return
      }
      setPhone(normalizedPhone)
      setCodeDelivery(data.delivery ?? null)
      setNextCodeDelivery(data.next_delivery ?? null)
      setResendAvailableAt(data.resend_available_at ?? null)
      setCanResendCode(Boolean(data.can_resend))
      setStage('code')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const sendCode = async (e: FormEvent) => {
    e.preventDefault()
    await requestCode()
  }

  const handleStageChange = (nextStage: TelegramConnectStage) => {
    setStage(nextStage)
    setError('')
    if (nextStage === 'phone' || nextStage === 'method') {
      setCode('')
      setPassword('')
      setCodeDelivery(null)
      setNextCodeDelivery(null)
      setResendAvailableAt(null)
      setCanResendCode(false)
      setQrUrl('')
      setQrWaiting(false)
    }
    if (nextStage === 'code') {
      setPassword('')
    }
    if (nextStage !== 'qr') {
      setQrWaiting(false)
    }
  }

  const resendCode = async () => {
    setError('')
    setLoading(true)
    try {
      const normalizedPhone = normalizeTelegramPhoneInput(phone)
      const { ok, data } = await callTelegramAuth<TelegramCodeStatusResponse>(
        EDGE_FN,
        session?.access_token,
        'resend_code',
        { phone: normalizedPhone },
      )
      if (!ok) {
        setError(resolveTelegramAuthError(data.error, ce.failedSendCode, ce))
        return
      }
      setPhone(normalizedPhone)
      setCodeDelivery(data.delivery ?? null)
      setNextCodeDelivery(data.next_delivery ?? null)
      setResendAvailableAt(data.resend_available_at ?? null)
      setCanResendCode(Boolean(data.can_resend))
      setStage('code')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const verifyCode = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const normalizedPhone = normalizeTelegramPhoneInput(phone)
      const normalizedCode = normalizeTelegramCodeInput(code)
      const { ok, data } = await callTelegramAuth<{ requires_password?: boolean; session_id?: string }>(
        EDGE_FN,
        session?.access_token,
        'verify_code',
        {
          phone: normalizedPhone,
          code: normalizedCode,
          password: stage === 'twoFa' ? password : undefined,
        },
      )
      if (data.requires_password) {
        setStage('twoFa')
        return
      }
      if (!ok || data.error) {
        setError(resolveTelegramAuthError(data.error, ce.verificationFailed, ce))
        if (isNoPendingPhoneAuthError(data.error)) {
          setPassword('')
          setStage('phone')
        }
        return
      }
      setPhone(normalizedPhone)
      setCode(normalizedCode)
      if (data.session_id) handleLinked(data.session_id)
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const verifyQrPassword = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { ok, data } = await callTelegramAuth<{ session_id?: string }>(
        EDGE_FN,
        session?.access_token,
        'verify_qr_password',
        { password },
      )
      if (!ok || data.error) {
        if (data.error === 'NO_PENDING_QR' && session?.user?.id) {
          const { data: sess } = await supabase
            .from('telegram_sessions')
            .select('id')
            .eq('user_id', session.user.id)
            .eq('is_active', true)
            .maybeSingle()
          if (sess?.id) {
            handleLinked(String(sess.id))
            return
          }
        }
        setError(resolveTelegramAuthErrorMessage(data.error, ce.verificationFailed, ce))
        return
      }
      if (data.session_id) {
        handleLinked(data.session_id)
      } else if (session?.user?.id) {
        const { data: sess } = await supabase
          .from('telegram_sessions')
          .select('id')
          .eq('user_id', session.user.id)
          .eq('is_active', true)
          .maybeSingle()
        if (sess?.id) handleLinked(String(sess.id))
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const finishLink = () => {
    if (!twoFaConfirmed || !sessionRowId) return
    setStage('done')
    onDone(sessionRowId)
  }

  if (stage === 'done') {
    return (
      <Card>
        <div className="text-center py-4">
          <div className="w-12 h-12 bg-success-50 rounded-full flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6 text-success-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Telegram connected</h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">Your session is saved and active.</p>
        </div>
      </Card>
    )
  }

  if (stage === 'confirm_2fa') {
    return (
      <Card>
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-5 h-5 text-teal-600" />
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Secure your Telegram account</h2>
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Accounts without a Two-Step Verification password are auto-flagged by Telegram much faster.
            Set one in the Telegram app before you continue, then confirm below.
          </p>
        </div>

        <ol className="space-y-2.5 text-sm text-neutral-700 dark:text-neutral-300 mb-5 list-decimal list-inside">
          <li>Open the Telegram app on your phone.</li>
          <li>Go to <span className="font-medium">Settings → Privacy and Security → Two-Step Verification</span>.</li>
          <li>Set a password and a recovery email.</li>
        </ol>

        <label className="flex items-start gap-2.5 p-3 border border-neutral-200 dark:border-neutral-800 rounded-lg cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
          <input
            type="checkbox"
            checked={twoFaConfirmed}
            onChange={e => setTwoFaConfirmed(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-neutral-300 text-teal-600 focus:ring-teal-500"
          />
          <span className="text-sm text-neutral-700 dark:text-neutral-300">
            I have set a Two-Step Verification password on this Telegram account.
          </span>
        </label>

        <Button
          type="button"
          onClick={finishLink}
          disabled={!twoFaConfirmed}
          className="w-full mt-5"
          size="lg"
        >
          Continue
        </Button>
      </Card>
    )
  }

  return (
    <TelegramConnectFlow
      stage={stage}
      onStageChange={handleStageChange}
      authMethod={authMethod}
      onAuthMethodChange={setAuthMethod}
      phone={phone}
      onPhoneChange={setPhone}
      code={code}
      onCodeChange={setCode}
      password={password}
      onPasswordChange={setPassword}
      codeDelivery={codeDelivery}
      nextCodeDelivery={nextCodeDelivery}
      resendAvailableAt={resendAvailableAt}
      canResend={canResendCode}
      qrUrl={qrUrl}
      qrWaiting={qrWaiting}
      loading={loading}
      error={error}
      onSendCode={sendCode}
      onResendCode={resendCode}
      onRequestNewCode={requestCode}
      onVerifyCode={verifyCode}
      onStartQr={startQrLogin}
      onVerifyQrPassword={verifyQrPassword}
    />
  )
}
