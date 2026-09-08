import { type FormEvent, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Smartphone, KeyRound, ListPlus, ShieldCheck, TriangleAlert, QrCode, Loader2 } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { Input } from '../ui/Input'
import type { TelegramCodeDelivery } from '../../lib/telegramAuthApi'

export type TelegramConnectStage = 'idle' | 'method' | 'phone' | 'code' | 'qr' | 'twoFa'
export type TelegramAuthMethod = 'phone' | 'qr'

interface TelegramConnectFlowProps {
  stage: TelegramConnectStage
  onStageChange: (stage: TelegramConnectStage) => void
  authMethod: TelegramAuthMethod
  onAuthMethodChange: (method: TelegramAuthMethod) => void
  phone: string
  onPhoneChange: (value: string) => void
  code: string
  onCodeChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  codeDelivery?: TelegramCodeDelivery | null
  nextCodeDelivery?: TelegramCodeDelivery | null
  resendAvailableAt?: string | null
  canResend?: boolean
  qrUrl: string
  qrWaiting: boolean
  loading: boolean
  error: string
  onSendCode: (e: FormEvent) => void
  onResendCode: () => void
  onRequestNewCode: () => void
  onVerifyCode: (e: FormEvent) => void
  onStartQr: () => void
  onVerifyQrPassword: (e: FormEvent) => void
}

const PHONE_STEPS = [
  { id: 'phone' as const, icon: Smartphone },
  { id: 'code' as const, icon: KeyRound },
  { id: 'twoFa' as const, icon: ShieldCheck },
  { id: 'channels' as const, icon: ListPlus },
]

const QR_STEPS = [
  { id: 'qr' as const, icon: QrCode },
  { id: 'twoFa' as const, icon: ShieldCheck },
  { id: 'channels' as const, icon: ListPlus },
]

function stepIndex(stage: TelegramConnectStage, authMethod: TelegramAuthMethod): number {
  if (stage === 'idle' || stage === 'method') return 0
  if (authMethod === 'qr') {
    if (stage === 'qr') return 1
    if (stage === 'twoFa') return 2
    return 0
  }
  if (stage === 'phone') return 1
  if (stage === 'code') return 2
  if (stage === 'twoFa') return 3
  return 0
}

export function TelegramConnectFlow({
  stage,
  onStageChange,
  authMethod,
  onAuthMethodChange,
  phone,
  onPhoneChange,
  code,
  onCodeChange,
  password,
  onPasswordChange,
  codeDelivery,
  nextCodeDelivery,
  resendAvailableAt,
  canResend = false,
  qrUrl,
  qrWaiting,
  loading,
  error,
  onSendCode,
  onResendCode,
  onRequestNewCode,
  onVerifyCode,
  onStartQr,
  onVerifyQrPassword,
}: TelegramConnectFlowProps) {
  const t = useT()
  const ce = t.copierEnginePage
  const steps = authMethod === 'qr' ? QR_STEPS : PHONE_STEPS
  const activeStep = stepIndex(stage, authMethod)

  const phoneStepLabels = [ce.tgConnectStepPhone, ce.tgConnectStepCode, ce.tgConnectStepTwoFa, ce.tgConnectStepChannels]
  const qrStepLabels = [ce.tgConnectStepQr, ce.tgConnectStepTwoFa, ce.tgConnectStepChannels]
  const stepLabels = authMethod === 'qr' ? qrStepLabels : phoneStepLabels
  const howItWorks = [ce.tgConnectHowItWorks1, ce.tgConnectHowItWorks2, ce.tgConnectHowItWorks3]
  const [now, setNow] = useState(() => Date.now())
  const resendAvailableAtMs = useMemo(() => {
    if (!resendAvailableAt) return null
    const parsed = new Date(resendAvailableAt).getTime()
    return Number.isFinite(parsed) ? parsed : null
  }, [resendAvailableAt])
  const resendWaitSeconds = resendAvailableAtMs ? Math.max(0, Math.ceil((resendAvailableAtMs - now) / 1000)) : 0
  const nextDeliveryHint =
    nextCodeDelivery === 'sms'
      ? ' If it does not arrive, SMS may become available after the countdown.'
      : nextCodeDelivery === 'call'
        ? ' If it does not arrive, a phone call may become available after the countdown.'
        : nextCodeDelivery
          ? ' If it does not arrive, another delivery method may become available after the countdown.'
          : ''
  const noAppFallback = codeDelivery === 'app' && !nextCodeDelivery && !canResend
  const codeHint =
    codeDelivery === 'app'
      ? `Telegram sent the login code through the Telegram app.${nextDeliveryHint}`
      : codeDelivery === 'call'
        ? `Telegram will call this number with the login code.${nextDeliveryHint}`
        : `${interpolate(ce.sentTo, { phone })}${nextDeliveryHint}`

  useEffect(() => {
    if (stage === 'qr' && !qrUrl && !loading && !error) {
      onStartQr()
    }
  }, [stage, qrUrl, loading, error, onStartQr])

  useEffect(() => {
    if (stage !== 'code' || !resendAvailableAtMs || resendWaitSeconds <= 0) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [stage, resendAvailableAtMs, resendWaitSeconds])

  const title =
    stage === 'method'
      ? ce.tgConnectMethodTitle
      : stage === 'phone'
        ? ce.tgConnectPhoneTitle
        : stage === 'code'
          ? ce.tgConnectCodeTitle
          : stage === 'qr'
            ? ce.tgConnectQrTitle
            : stage === 'twoFa'
              ? authMethod === 'qr'
                ? ce.tgConnectTwoFaTitle
                : ce.tgConnectTwoFaTitle
              : ce.tgConnectHeroTitle

  const subtitle =
    stage === 'method'
      ? ce.tgConnectMethodSubtitle
      : stage === 'phone'
        ? ce.tgConnectPhoneSubtitle
        : stage === 'code'
          ? ce.tgConnectCodeSubtitle
          : stage === 'qr'
            ? ce.tgConnectQrSubtitle
            : stage === 'twoFa'
              ? authMethod === 'qr'
                ? ce.tgConnectQrTwoFaSubtitle
                : ce.tgConnectTwoFaSubtitle
              : ce.tgConnectHeroSubtitle

  const showSteps = stage !== 'idle' && stage !== 'method'

  return (
    <Card className="mb-4 overflow-hidden" padding="none">
      <div className="relative px-5 pt-6 pb-5 sm:px-6 sm:pt-7 bg-gradient-to-br from-[#229ED9]/12 via-sky-50/90 to-white dark:from-[#229ED9]/20 dark:via-sky-950/30 dark:to-neutral-900 border-b border-neutral-100 dark:border-neutral-800">
        <div className="flex flex-col items-center text-center max-w-md mx-auto">
          <div className="w-14 h-14 rounded-2xl bg-white dark:bg-neutral-800 shadow-md border border-neutral-100 dark:border-neutral-700 flex items-center justify-center mb-3">
            <img src="/Telegram.svg" alt="" className="w-8 h-8 object-contain" loading="lazy" aria-hidden />
          </div>
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{subtitle}</p>
        </div>

        {showSteps && (
          <ol className="mt-6 flex items-center justify-center gap-0 max-w-sm mx-auto" aria-label={ce.tgConnectStepsAria}>
            {steps.map((step, i) => {
              const done = i < activeStep
              const current = i === activeStep
              const Icon = step.icon
              return (
                <li key={step.id} className="flex items-center flex-1 last:flex-none">
                  <div className="flex flex-col items-center gap-1.5 min-w-0">
                    <span
                      className={clsx(
                        'w-9 h-9 rounded-full flex items-center justify-center border-2 transition-colors',
                        done && 'bg-teal-600 border-teal-600 text-white',
                        current && !done && 'bg-white dark:bg-neutral-800 border-teal-600 text-teal-600',
                        !done && !current && 'bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700 text-neutral-400',
                      )}
                    >
                      {done ? <Check className="w-4 h-4" strokeWidth={2.5} /> : <Icon className="w-4 h-4" />}
                    </span>
                    <span
                      className={clsx(
                        'text-[10px] sm:text-xs font-medium truncate max-w-[4.5rem] sm:max-w-none text-center',
                        current ? 'text-teal-700 dark:text-teal-400' : done ? 'text-neutral-600 dark:text-neutral-300' : 'text-neutral-400',
                      )}
                    >
                      {stepLabels[i]}
                    </span>
                  </div>
                  {i < steps.length - 1 && (
                    <div
                      className={clsx(
                        'h-0.5 flex-1 mx-1 sm:mx-2 mb-5 rounded-full transition-colors',
                        i < activeStep ? 'bg-teal-500' : 'bg-neutral-200 dark:bg-neutral-700',
                      )}
                      aria-hidden
                    />
                  )}
                </li>
              )
            })}
          </ol>
        )}
      </div>

      <div className="px-5 py-5 sm:px-6 sm:py-6 max-w-md mx-auto">
        {stage === 'idle' && (
          <ul className="space-y-2.5 mb-5">
            {howItWorks.map((line, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-neutral-600 dark:text-neutral-300">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary-100 dark:bg-primary-900/50 text-primary-700 dark:text-primary-300 text-xs font-semibold flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                {line}
              </li>
            ))}
          </ul>
        )}

        {(stage === 'phone' || stage === 'code' || stage === 'twoFa' || stage === 'qr') && (
          <div className="mb-4 px-3 py-2.5 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-900/50 rounded-xl flex items-start gap-2.5">
            <TriangleAlert className="w-4 h-4 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 dark:text-amber-200/90 leading-relaxed">{ce.tgConnectPhoneWarning}</p>
          </div>
        )}

        {error && <Alert className="mb-4">{error}</Alert>}

        {stage === 'idle' && (
          <Button size="lg" className="w-full" onClick={() => onStageChange('method')}>
            <img src="/Telegram.svg" alt="" className="w-5 h-5 object-contain" loading="lazy" aria-hidden />
            {ce.connectTelegram}
          </Button>
        )}

        {stage === 'method' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => onAuthMethodChange('phone')}
                className={clsx(
                  'rounded-xl border-2 p-4 text-left transition-colors',
                  authMethod === 'phone'
                    ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/30'
                    : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300',
                )}
              >
                <Smartphone className="w-5 h-5 mb-2 text-teal-600" />
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{ce.tgConnectMethodPhone}</p>
              </button>
              <button
                type="button"
                onClick={() => onAuthMethodChange('qr')}
                className={clsx(
                  'rounded-xl border-2 p-4 text-left transition-colors',
                  authMethod === 'qr'
                    ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/30'
                    : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300',
                )}
              >
                <QrCode className="w-5 h-5 mb-2 text-teal-600" />
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{ce.tgConnectMethodQr}</p>
              </button>
            </div>
            <Button
              size="lg"
              className="w-full"
              onClick={() => {
                if (authMethod === 'qr') {
                  onStageChange('qr')
                } else {
                  onStageChange('phone')
                }
              }}
            >
              {authMethod === 'qr' ? ce.tgConnectMethodQr : ce.sendCode}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => onStageChange('idle')}>
              {ce.cancelConnect}
            </Button>
          </div>
        )}

        {stage === 'phone' && (
          <form onSubmit={onSendCode} className="space-y-4">
            <Input
              label={ce.phoneLabel}
              type="tel"
              placeholder={ce.phonePlaceholder}
              value={phone}
              onChange={e => onPhoneChange(e.target.value)}
              hint={ce.phoneHint}
              required
              autoFocus
            />
            <Button type="submit" loading={loading} size="lg" className="w-full">
              {ce.sendCode}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => onStageChange('method')}>
              {ce.back}
            </Button>
          </form>
        )}

        {stage === 'code' && (
          <form onSubmit={onVerifyCode} className="space-y-4">
            {codeDelivery === 'app' && (
              <Alert variant="warning" className="text-left">
                <div className="flex items-start gap-2">
                  <Smartphone className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <p>{ce.tgConnectCodeAppHint}</p>
                </div>
              </Alert>
            )}
            <Input
              label={ce.verificationCode}
              placeholder={ce.verificationPlaceholder}
              value={code}
              onChange={e => onCodeChange(e.target.value)}
              hint={codeHint}
              required
              autoFocus
            />
            <Button type="submit" loading={loading} size="lg" className="w-full">
              {ce.verify}
            </Button>
            {canResend && (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={loading || resendWaitSeconds > 0}
                onClick={onResendCode}
              >
                {resendWaitSeconds > 0
                  ? `Request another delivery method in ${resendWaitSeconds}s`
                  : 'Request another delivery method'}
              </Button>
            )}
            {!canResend && (
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={loading}
                onClick={onRequestNewCode}
              >
                {ce.sendNewCode}
              </Button>
            )}
            {noAppFallback && (
              <Button
                type="button"
                className="w-full"
                onClick={() => {
                  onAuthMethodChange('qr')
                  onStageChange('qr')
                }}
              >
                <QrCode className="w-4 h-4" />
                Connect with QR instead
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => onStageChange('phone')}
            >
              {ce.useDifferentNumber}
            </Button>
          </form>
        )}

        {stage === 'qr' && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-4">
              <div className="rounded-2xl bg-white p-4 shadow-sm border border-neutral-200 dark:border-neutral-700">
                {qrUrl ? (
                  <QRCodeSVG value={qrUrl} size={200} level="M" includeMargin />
                ) : (
                  <div className="w-[200px] h-[200px] flex items-center justify-center">
                    <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
                  </div>
                )}
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center leading-relaxed max-w-xs">
                {ce.tgConnectQrInstructions}
              </p>
              {qrWaiting && (
                <p className="text-sm text-teal-700 dark:text-teal-400 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {ce.tgConnectQrWaiting}
                </p>
              )}
            </div>
            <Button type="button" variant="ghost" className="w-full" onClick={() => onStageChange('method')}>
              {ce.back}
            </Button>
          </div>
        )}

        {stage === 'twoFa' && (
          <form onSubmit={authMethod === 'qr' ? onVerifyQrPassword : onVerifyCode} className="space-y-4">
            {authMethod === 'phone' && (
              <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 px-4 py-3">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{ce.verificationCode}</p>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 mt-0.5 font-mono tracking-wide">
                  {code || '—'}
                </p>
                <p className="text-xs text-neutral-400 mt-1">{codeHint}</p>
              </div>
            )}
            <Input
              label={ce.twoFaPassword}
              type="password"
              placeholder={ce.twoFaPlaceholder}
              value={password}
              onChange={e => onPasswordChange(e.target.value)}
              hint={ce.twoFaRequired}
              required
              autoFocus
            />
            <Button type="submit" loading={loading} size="lg" className="w-full">
              {ce.verify}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => onStageChange(authMethod === 'qr' ? 'qr' : 'code')}
            >
              {authMethod === 'qr' ? ce.back : ce.backToVerificationCode}
            </Button>
          </form>
        )}
      </div>
    </Card>
  )
}
