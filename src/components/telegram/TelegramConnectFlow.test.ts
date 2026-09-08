import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocaleContext } from '../../context/localeContextInstance'
import { getTranslations } from '../../i18n/locales'
import { TelegramConnectFlow, type TelegramConnectStage } from './TelegramConnectFlow'

function renderFlow(opts: {
  stage?: TelegramConnectStage
  codeDelivery?: 'app' | 'sms' | 'call' | 'other' | null
  nextCodeDelivery?: 'app' | 'sms' | 'call' | 'other' | null
  canResend?: boolean
  resendAvailableAt?: string | null
}) {
  const t = getTranslations('en')
  return renderToStaticMarkup(
    React.createElement(
      LocaleContext.Provider,
      {
        value: {
          locale: 'en',
          setLocale: () => {},
          dir: 'ltr',
          t,
          auth: t.auth,
        },
      },
      React.createElement(TelegramConnectFlow, {
        stage: opts.stage ?? 'code',
        onStageChange: () => {},
        authMethod: 'phone',
        onAuthMethodChange: () => {},
        phone: '+15551234567',
        onPhoneChange: () => {},
        code: '',
        onCodeChange: () => {},
        password: '',
        onPasswordChange: () => {},
        codeDelivery: opts.codeDelivery ?? null,
        nextCodeDelivery: opts.nextCodeDelivery ?? null,
        resendAvailableAt: opts.resendAvailableAt ?? null,
        canResend: opts.canResend ?? false,
        qrUrl: '',
        qrWaiting: false,
        loading: false,
        error: '',
        onSendCode: () => {},
        onResendCode: () => {},
        onRequestNewCode: () => {},
        onVerifyCode: () => {},
        onStartQr: () => {},
        onVerifyQrPassword: () => {},
      }),
    ),
  )
}

describe('TelegramConnectFlow phone-code fallback state', () => {
  it('shows a prominent app-hint and a "Send a new code" button when app delivery has no Telegram resend path', () => {
    const html = renderFlow({ codeDelivery: 'app', nextCodeDelivery: null, canResend: false })

    expect(html).toContain('Telegram sent the login code through the Telegram app.')
    expect(html).toContain('The code is NOT sent by SMS.')
    expect(html).toContain('Send a new code')
    expect(html).toContain('Connect with QR instead')
    expect(html).not.toContain('Request another delivery method')
    expect(html).not.toContain('SMS may become available')
    expect(html).not.toContain('Telegram will call')
  })

  it('shows resend and truthful SMS copy only when Telegram returns SMS as the next delivery', () => {
    const html = renderFlow({
      codeDelivery: 'app',
      nextCodeDelivery: 'sms',
      canResend: true,
      resendAvailableAt: new Date(Date.now() + 30_000).toISOString(),
    })

    expect(html).toContain('SMS may become available after the countdown.')
    expect(html).toContain('Request another delivery method')
    expect(html).not.toContain('Send a new code')
    expect(html).not.toContain('Connect with QR instead')
  })
})
