import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Radio, Trash2, RefreshCw, CircleAlert as AlertCircle, ChevronDown, Plus, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { whenRealtimeReady } from '../../lib/whenRealtimeReady'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { isBrokerCopyEnabled } from '../../lib/brokerLink'
import {
  brokersMatchingChannel,
  brokersNotMatchingChannel,
  connectChannelToBroker,
  disconnectChannelFromBroker,
  getBrokerDisplayLabel,
  pruneStaleBrokerChannelIds,
} from '../../lib/brokerChannelLink'
import { triggerBackgroundChannelAiTraining } from '../../lib/channelAiTrainingBackground'
import { defaultChannelFiltersForPlan } from '../../lib/channelMessageFilters'
import { prepareChannelSubscriptionUpsert } from '../../lib/signalChannelRegistry'
import { upsertTelegramChannel, planLimitErrorMessage } from '../../lib/telegramChannelApi'
import {
  hasValidTelegramChannelIdentity,
  isNumericTelegramChatId,
} from '../../lib/telegramChannelIdentity'
import {
  reconcileChannelIdentitiesFromTelegram,
  removeStaleDuplicateChannels,
} from '../../lib/telegramChannelReconcile'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Toggle } from '../../components/ui/Toggle'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { TelegramConnectFlow, type TelegramConnectStage, type TelegramAuthMethod } from '../../components/telegram/TelegramConnectFlow'
import { callTelegramAuth, resolveResendAvailableAt, resolveTelegramAuthErrorMessage, type QrPollResponse, type TelegramCodeStatusResponse } from '../../lib/telegramAuthApi'
import {
  getCachedTgChannels,
  invalidateTgChannelsCache,
  setCachedTgChannels,
  type TgChannelListItem,
} from '../../lib/telegramChannelsCache'
import { resolveTelegramAuthError, isNoPendingPhoneAuthError } from '../../lib/telegramAuthError'
import type { TelegramCodeDelivery } from '../../lib/telegramAuthApi'
import {
  getCachedTgSession,
  invalidateTgSessionCache,
  setCachedTgSession,
} from '../../lib/telegramSessionCache'
import {
  fetchListenerLeaseStatus,
  type ListenerLeaseSnapshot,
} from '../../lib/listenerLeaseStatus'
import type { BrokerAccount, TelegramChannel } from '../../types/database'

function getTelegramAvatarUrl(username?: string): string | null {
  if (!username) return null
  return `https://t.me/i/userpic/320/${username}.jpg`
}

function normalizeTelegramPhoneInput(raw: string): string {
  const compact = String(raw ?? '').trim().replace(/[\s\-()]/g, '')
  if (compact.startsWith('00')) return `+${compact.slice(2)}`
  return compact
}

function normalizeTelegramCodeInput(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '')
}

function TgChannelAvatar({ title, username }: { title: string; username?: string }) {
  const [imageFailed, setImageFailed] = useState(false)
  const avatarUrl = getTelegramAvatarUrl(username)

  return (
    <div className="w-8 h-8 rounded-lg bg-primary-50 text-primary-600 flex items-center justify-center flex-shrink-0 overflow-hidden">
      {avatarUrl && !imageFailed ? (
        <img
          src={avatarUrl}
          alt={`${title} avatar`}
          className="w-full h-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <img
          src="/Telegram.svg"
          alt="Telegram"
          className="w-5 h-5 object-contain"
          loading="lazy"
        />
      )}
    </div>
  )
}

export function CopierEnginePage() {
  const t = useT()
  const ce = t.copierEnginePage
  const { user, session } = useAuth()
  const initialTgCache = user?.id ? getCachedTgChannels(user.id) : null
  const initialTgSession = user?.id ? getCachedTgSession(user.id) : null
  const { brokers, replaceBroker, setBrokers, refreshBrokers } = useBrokerAccounts()
  const {
    hasActiveSubscription,
    canAddChannel,
    limits,
    refresh: refreshSubscription,
    canUseFeature: canUsePlanFeature,
  } = useSubscription()
  const keywordFiltersEnabled = canUsePlanFeature('channel_keyword_filters')
  const channelLinkDefaultFilters = defaultChannelFiltersForPlan(keywordFiltersEnabled)
  const pw = t.pricing.paywall
  const [channels, setChannels] = useState<TelegramChannel[]>([])
  const [connectMenuChannelId, setConnectMenuChannelId] = useState<string | null>(null)
  const [connectingBrokerId, setConnectingBrokerId] = useState<string | null>(null)
  const [connectingAllChannelId, setConnectingAllChannelId] = useState<string | null>(null)
  const [disconnectingLinkKey, setDisconnectingLinkKey] = useState<string | null>(null)
  const [tgChannels, setTgChannels] = useState<TgChannelListItem[]>(initialTgCache ?? [])
  const [loading, setLoading] = useState(true)
  const [loadingTg, setLoadingTg] = useState(false)
  const [tgChannelsCollapsed, setTgChannelsCollapsed] = useState(false)
  const [error, setError] = useState('')
  const [tgChannelSearch, setTgChannelSearch] = useState('')
  const [hasTgSession, setHasTgSession] = useState(
    () => initialTgSession ?? Boolean(initialTgCache),
  )
  const [tgStage, setTgStage] = useState<'idle' | 'method' | 'phone' | 'code' | 'qr' | 'twoFa' | 'linked'>('idle')
  const [tgAuthMethod, setTgAuthMethod] = useState<TelegramAuthMethod>('phone')
  const [tgQrUrl, setTgQrUrl] = useState('')
  const [tgQrWaiting, setTgQrWaiting] = useState(false)
  const [tgPhone, setTgPhone] = useState('')
  const [tgCode, setTgCode] = useState('')
  const [tgCodeDelivery, setTgCodeDelivery] = useState<TelegramCodeDelivery | null>(null)
  const [tgNextCodeDelivery, setTgNextCodeDelivery] = useState<TelegramCodeDelivery | null>(null)
  const [tgResendAvailableAt, setTgResendAvailableAt] = useState<string | null>(null)
  const [tgCanResendCode, setTgCanResendCode] = useState(false)
  const [tgPassword, setTgPassword] = useState('')
  const [tgLoading, setTgLoading] = useState(false)
  const [tgError, setTgError] = useState('')
  const [listenerLease, setListenerLease] = useState<ListenerLeaseSnapshot>({
    status: 'unknown',
    expiresAt: null,
  })

  const EDGE_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`

  const refreshListenerLease = useCallback(async () => {
    if (!user?.id) return
    const snap = await fetchListenerLeaseStatus(supabase, user.id)
    setListenerLease(snap)
  }, [user?.id])

  useEffect(() => {
    if (!user) return
    const cached = getCachedTgChannels(user.id)
    if (cached) setTgChannels(cached)
    void loadData({ skipTgFetch: Boolean(cached) })
  }, [user])

  useEffect(() => {
    if (!user?.id) return

    let cancelled = false
    let rt: ReturnType<typeof supabase.channel> | null = null

    void whenRealtimeReady(user.id).then(() => {
      if (cancelled) return
      rt = supabase
        .channel(`telegram_channels_ui:${user.id}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'telegram_channels',
            filter: `user_id=eq.${user.id}`,
          },
          payload => {
            const row = payload.new as TelegramChannel
            if (!row?.id) return
            setChannels(prev => prev.map(c => (c.id === row.id ? { ...c, ...row } : c)))
          },
        )
        .subscribe()
    })

    return () => {
      cancelled = true
      if (rt) void supabase.removeChannel(rt)
    }
  }, [user?.id])

  useEffect(() => {
    if (!user?.id || !hasTgSession) {
      setListenerLease({ status: 'unknown', expiresAt: null })
      return
    }
    void refreshListenerLease()
    const interval = setInterval(() => void refreshListenerLease(), 30_000)
    return () => clearInterval(interval)
  }, [user?.id, hasTgSession, refreshListenerLease])

  useEffect(() => {
    if (!user?.id || !hasTgSession) return

    let cancelled = false
    let rt: ReturnType<typeof supabase.channel> | null = null

    void whenRealtimeReady(user.id).then(() => {
      if (cancelled) return
      rt = supabase
        .channel(`worker_session_leases_ui:${user.id}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'worker_session_leases',
            filter: `user_id=eq.${user.id}`,
          },
          () => void refreshListenerLease(),
        )
        .subscribe()
    })

    return () => {
      cancelled = true
      if (rt) void supabase.removeChannel(rt)
    }
  }, [user?.id, hasTgSession, refreshListenerLease])

  const loadData = async (opts?: { skipTgFetch?: boolean; backgroundTgFetch?: boolean; forceTgFetch?: boolean }) => {
    const [channelsRes, sessionRes] = await Promise.all([
      supabase.from('telegram_channels').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }),
      supabase.from('telegram_sessions').select('id').eq('user_id', user!.id).maybeSingle(),
    ])
    const channelRows = (channelsRes.data ?? []) as TelegramChannel[]
    const tgList = user?.id ? getCachedTgChannels(user.id) : null
    const reconciledChannels = tgList?.length
      ? await reconcileChannelIdentitiesFromTelegram(supabase, user!.id, channelRows, tgList)
      : channelRows
    setChannels(reconciledChannels)
    const brokerRows = await refreshBrokers({ silent: true })
    const reconciled = await pruneStaleBrokerChannelIds(supabase, user!.id, reconciledChannels, brokerRows)
    setBrokers(reconciled)
    const hasSession = !!sessionRes.data
    setHasTgSession(hasSession)
    if (user?.id) setCachedTgSession(user.id, hasSession)
    setTgStage(prev =>
      prev === 'phone' || prev === 'code' || prev === 'twoFa' || prev === 'qr' || prev === 'method'
        ? prev
        : hasSession
          ? 'linked'
          : 'idle',
    )
    setLoading(false)
    if (hasSession) void refreshListenerLease()
    if (hasSession && !opts?.skipTgFetch) {
      const cached = user?.id ? getCachedTgChannels(user.id) : null
      if (cached && !opts?.forceTgFetch) {
        setTgChannels(cached)
      } else {
        void fetchTgChannels({
          background: opts?.backgroundTgFetch ?? Boolean(cached),
          force: opts?.forceTgFetch,
        })
      }
    }
  }

  /** Remove Telegram session only (manual disconnect). Keeps configured channels. */
  const clearTelegramConnection = useCallback(async (nextStage: 'idle' | 'phone') => {
    if (!user?.id) return
    const { ok } = await callTelegramAuth(EDGE_FN, session?.access_token, 'disconnect_telegram', {})
    if (!ok) {
      // Fall back to client-side session delete if worker is unreachable / outdated.
      await supabase.from('telegram_sessions').delete().eq('user_id', user.id)
    }
    setHasTgSession(false)
    setTgChannels([])
    setTgChannelSearch('')
    if (user.id) {
      invalidateTgChannelsCache(user.id)
      invalidateTgSessionCache(user.id)
    }
    setTgError('')
    setError('')
    setTgCode('')
    setTgCodeDelivery(null)
    setTgNextCodeDelivery(null)
    setTgResendAvailableAt(null)
    setTgCanResendCode(false)
    setTgPassword('')
    setTgStage(nextStage)
    void refreshListenerLease()
  }, [user, session?.access_token, EDGE_FN, refreshListenerLease])

  /** Session revoked server-side — show reconnect UI; never wipe configured channels. */
  const handleTelegramSessionInvalid = useCallback(async () => {
    if (!user?.id) return
    setHasTgSession(false)
    setTgChannels([])
    setTgChannelSearch('')
    invalidateTgChannelsCache(user.id)
    invalidateTgSessionCache(user.id)
    setTgError(ce.telegramSessionExpired)
    const { data: channelRows } = await supabase
      .from('telegram_channels')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    setChannels((channelRows ?? []) as TelegramChannel[])
    setTgStage('method')
  }, [user, ce.telegramSessionExpired])

  /** Soft-reconnect live listener with the saved session; fall back to re-link UI only if session is gone. */
  const reconnectTelegram = useCallback(async () => {
    setError('')
    setTgError('')
    setTgCode('')
    setTgPassword('')
    if (!hasTgSession) {
      setTgStage('method')
      return
    }
    setLoadingTg(true)
    try {
      const { ok, status, data } = await callTelegramAuth<{
        channels?: TgChannelListItem[]
        code?: string
      }>(EDGE_FN, session?.access_token, 'reconnect_telegram', {})
      if (data.code === 'TELEGRAM_SESSION_INVALID' || status === 401) {
        await handleTelegramSessionInvalid()
        return
      }
      if (!ok || data.error) {
        const errText = typeof data.error === 'string' ? data.error : ''
        const isBusy = /temporarily busy|AUTH_KEY_DUPLICATED|still closing|reconnecting/i.test(errText)
        setError(isBusy ? ce.telegramConnectionBusy : (errText || ce.failedLoadTgChannels))
        return
      }
      const list = (data.channels ?? []) as TgChannelListItem[]
      setTgChannels(list)
      if (user?.id) setCachedTgChannels(user.id, list)
      setError('')
      void refreshListenerLease()
    } catch {
      setError(ce.networkError)
    } finally {
      setLoadingTg(false)
    }
  }, [
    hasTgSession,
    session?.access_token,
    EDGE_FN,
    handleTelegramSessionInvalid,
    ce.telegramConnectionBusy,
    ce.failedLoadTgChannels,
    ce.networkError,
    user?.id,
    refreshListenerLease,
  ])

  const isTgReconnectFlow =
    tgStage === 'method' || tgStage === 'phone' || tgStage === 'code' || tgStage === 'qr' || tgStage === 'twoFa'
  const showTelegramConnectFlow = !hasTgSession || isTgReconnectFlow

  const fetchTgChannels = async (opts?: { background?: boolean; force?: boolean }) => {
    if (!opts?.force && user?.id) {
      const cached = getCachedTgChannels(user.id)
      if (cached) {
        setTgChannels(cached)
        return
      }
    }
    setLoadingTg(true)
    if (!opts?.background) setError('')
    const maxAttempts = 3
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 1500 * attempt))
        }
        try {
          const { status: resStatus, data } = await callTelegramAuth<{
            channels?: TgChannelListItem[]
            code?: string
          }>(EDGE_FN, session?.access_token, 'list_channels', {})
          const res = { status: resStatus, ok: resStatus >= 200 && resStatus < 300 }
          if (data.code === 'TELEGRAM_SESSION_INVALID') {
            await handleTelegramSessionInvalid()
            return
          }
          if (res.status === 401) {
            if (!opts?.background) {
              const msg = typeof data.error === 'string' ? data.error : ce.failedLoadTgChannels
              setError(msg)
            }
            return
          }
          if (!res.ok || data.error) {
            const errText = typeof data.error === 'string' ? data.error : ''
            const isBusy = /temporarily busy|AUTH_KEY_DUPLICATED|still closing|reconnecting/i.test(errText)
            if (isBusy) {
              if (!opts?.background) setError(ce.telegramConnectionBusy)
              return
            }
            if (attempt < maxAttempts - 1) continue
            if (!opts?.background) {
              setError(errText || ce.failedLoadTgChannels)
            }
            return
          }
          const list = (data.channels ?? []) as TgChannelListItem[]
          setTgChannels(list)
          if (user?.id) {
            setCachedTgChannels(user.id, list)
            const { data: channelRows } = await supabase
              .from('telegram_channels')
              .select('*')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false })
            const reconciled = await reconcileChannelIdentitiesFromTelegram(
              supabase,
              user.id,
              (channelRows ?? []) as TelegramChannel[],
              list,
            )
            setChannels(reconciled)
          }
          if (!opts?.background) setError('')
          return
        } catch {
          if (attempt >= maxAttempts - 1 && !opts?.background) {
            setError(ce.failedLoadTgChannels)
          }
        }
      }
    } finally {
      setLoadingTg(false)
    }
  }

  const filteredTgChannels = useMemo(() => {
    const q = tgChannelSearch.trim().toLowerCase()
    if (!q) return tgChannels
    return tgChannels.filter(ch => {
      const title = (ch.title ?? '').toLowerCase()
      const user = (ch.username ?? '').toLowerCase().replace(/^@/, '')
      return title.includes(q) || user.includes(q) || `@${user}`.includes(q)
    })
  }, [tgChannels, tgChannelSearch])


  const toggleChannel = async (id: string, is_active: boolean) => {
    setChannels(prev => prev.map(c => c.id === id ? { ...c, is_active } : c))
    const { error: upErr } = await supabase.from('telegram_channels').update({ is_active }).eq('id', id)
    if (upErr) {
      setChannels(prev => prev.map(c => c.id === id ? { ...c, is_active: !is_active } : c))
      setError(planLimitErrorMessage(upErr.message))
      return
    }
    void refreshSubscription()
  }

  const deleteChannel = async (id: string) => {
    setChannels(prev => prev.filter(c => c.id !== id))
    await supabase.from('telegram_channels').delete().eq('id', id)
    void refreshSubscription()
  }

  const handleConnectChannelToBroker = async (channelId: string, brokerId: string) => {
    if (!user) return
    const broker = brokers.find(b => b.id === brokerId)
    if (!broker) return
    setConnectingBrokerId(brokerId)
    setError('')
    const { broker: updated, error: linkErr } = await connectChannelToBroker(
      supabase,
      user.id,
      broker,
      channelId,
      { defaultChannelFilters: channelLinkDefaultFilters },
    )
    setConnectingBrokerId(null)
    if (linkErr) {
      setError(linkErr)
      return
    }
    if (updated) {
      replaceBroker(updated)
      void triggerBackgroundChannelAiTraining(channelId, { userId: user.id })
    }
    setConnectMenuChannelId(null)
  }

  const handleConnectAllBrokersToChannel = async (channelId: string) => {
    if (!user) return
    const toLink = brokersNotMatchingChannel(
      brokers.filter(b => isBrokerCopyEnabled(b)),
      channelId,
    )
    if (toLink.length === 0) return
    setConnectingAllChannelId(channelId)
    setError('')
    let nextBrokers = [...brokers]
    for (const broker of toLink) {
      const { broker: updated, error: linkErr } = await connectChannelToBroker(
        supabase,
        user.id,
        broker,
        channelId,
        { defaultChannelFilters: channelLinkDefaultFilters },
      )
      if (linkErr) {
        setError(linkErr)
        break
      }
      if (updated) {
        nextBrokers = nextBrokers.map(b => (b.id === updated.id ? updated : b))
      }
    }
    setBrokers(nextBrokers)
    void triggerBackgroundChannelAiTraining(channelId, { userId: user.id })
    setConnectingAllChannelId(null)
    setConnectMenuChannelId(null)
  }

  const handleDisconnectChannelFromBroker = async (channelId: string, brokerId: string) => {
    if (!user) return
    const broker = brokers.find(b => b.id === brokerId)
    if (!broker) return
    const linkKey = `${channelId}:${brokerId}`
    setDisconnectingLinkKey(linkKey)
    setError('')
    const { broker: updated, error: linkErr } = await disconnectChannelFromBroker(
      supabase,
      user.id,
      broker,
      channelId,
    )
    setDisconnectingLinkKey(null)
    if (linkErr) {
      setError(linkErr)
      return
    }
    if (updated) {
      replaceBroker(updated)
    }
  }

  const addFromTg = async (ch: { id: string; title: string; username: string }) => {
    setError('')
    const alreadyLinked = channels.some(row => row.channel_id === ch.id)
    if (hasActiveSubscription && !alreadyLinked && !canAddChannel()) {
      setError(interpolate(pw.channelLimit, { limit: String(limits.maxTelegramChannels ?? 5) }))
      return
    }
    await removeStaleDuplicateChannels(supabase, user!.id, { id: ch.id, title: ch.title })
    const prepared = await prepareChannelSubscriptionUpsert(supabase, {
      userId: user!.id,
      telegramChatId: ch.id,
      channelUsername: ch.username,
      displayName: ch.title,
    })
    if (prepared.error) {
      setError(prepared.error)
      return
    }
    const { channel: data, error: dbErr } = await upsertTelegramChannel({
      channel_id: String(prepared.row.channel_id),
      channel_username: String(prepared.row.channel_username ?? ''),
      display_name: String(prepared.row.display_name ?? ''),
      is_active: true,
    })
    if (dbErr || !data) {
      setError(dbErr ?? 'Failed to add channel')
      return
    }
    const upserted = data
    setChannels(prev => {
      const titleKey = ch.title.trim().toLowerCase()
      const withoutStale = prev.filter(row =>
        row.channel_id === ch.id
        || row.display_name.trim().toLowerCase() !== titleKey
        || hasValidTelegramChannelIdentity(row),
      )
      const prevExists = withoutStale.find(c => c.channel_id === ch.id)
      return prevExists
        ? withoutStale.map(c => (c.channel_id === ch.id ? upserted : c))
        : [upserted, ...withoutStale]
    })
    setConnectMenuChannelId(upserted.id)
    void refreshSubscription()
    void triggerBackgroundChannelAiTraining(upserted.id, { userId: user!.id })
  }

  const handleTelegramLinked = async (data: { channels?: TgChannelListItem[] }) => {
    setTgQrUrl('')
    setTgQrWaiting(false)
    setTgError('')
    setHasTgSession(true)
    if (user?.id) setCachedTgSession(user.id, true)
    setTgStage('linked')
    if (Array.isArray(data.channels)) {
      const list = data.channels as TgChannelListItem[]
      setTgChannels(list)
      if (user?.id) setCachedTgChannels(user.id, list)
      await loadData({ skipTgFetch: true })
    } else {
      await loadData()
    }
  }

  const startQrLogin = useCallback(async () => {
    setTgError('')
    setTgLoading(true)
    setTgQrWaiting(true)
    try {
      const { ok, data } = await callTelegramAuth<{ qr_url?: string; expires_at?: string }>(
        EDGE_FN,
        session?.access_token,
        'start_qr_login',
        {},
      )
      if (!ok || !data.qr_url) {
        setTgQrWaiting(false)
        setTgError(resolveTelegramAuthErrorMessage(data.error, ce.failedStartQr, ce))
        return
      }
      setTgQrUrl(data.qr_url)
    } catch {
      setTgQrWaiting(false)
      setTgError(ce.networkError)
    } finally {
      setTgLoading(false)
    }
  }, [session?.access_token, ce])

  useEffect(() => {
    // Only poll after start_qr_login returned a URL — earlier polls race prepareForAuth
    // and surface a false "QR login expired".
    if (tgStage !== 'qr' || !session?.access_token || !tgQrUrl) return

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
        if (data.qr_url && data.qr_url !== tgQrUrl) {
          setTgQrUrl(data.qr_url)
        }
        if (data.status === 'requires_password' || data.requires_password) {
          setTgQrWaiting(false)
          setTgError('')
          setTgStage('twoFa')
          return
        }
        if (data.status === 'success' && data.session_id) {
          setTgQrWaiting(false)
          await handleTelegramLinked({ channels: data.channels as TgChannelListItem[] | undefined })
          return
        }
        if (data.status === 'waiting') return
        if (data.status === 'error' || (!ok && data.error)) {
          // QR may have completed and cleared pending — recover if session exists.
          if (data.error === 'NO_PENDING_QR' && user?.id) {
            const { data: sess } = await supabase
              .from('telegram_sessions')
              .select('user_id')
              .eq('user_id', user.id)
              .eq('is_active', true)
              .maybeSingle()
            if (cancelled) return
            if (sess) {
              setTgQrWaiting(false)
              await handleTelegramLinked({})
              return
            }
          }
          setTgQrWaiting(false)
          setTgError(resolveTelegramAuthErrorMessage(data.error, ce.failedStartQr, ce))
        }
      } catch {
        if (!cancelled) setTgError(ce.networkError)
      }
    }

    void poll()
    const interval = setInterval(() => void poll(), 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // Intentionally omit tgQrUrl from deps besides presence — URL token refreshes
    // update state inside poll without resetting the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll only while QR stage has a URL
  }, [tgStage, session?.access_token, Boolean(tgQrUrl), user?.id, ce.failedStartQr, ce.networkError])

  const verifyQrPassword = async (e: FormEvent) => {
    e.preventDefault()
    setTgError('')
    setTgLoading(true)
    try {
      const { ok, data } = await callTelegramAuth<{ session_id?: string; channels?: TgChannelListItem[] }>(
        EDGE_FN,
        session?.access_token,
        'verify_qr_password',
        { password: tgPassword },
      )
      if (!ok || data.error) {
        if (data.error === 'NO_PENDING_QR' && user?.id) {
          const { data: sess } = await supabase
            .from('telegram_sessions')
            .select('user_id')
            .eq('user_id', user.id)
            .eq('is_active', true)
            .maybeSingle()
          if (sess) {
            await handleTelegramLinked({})
            return
          }
        }
        setTgError(resolveTelegramAuthErrorMessage(data.error, ce.verificationFailed, ce))
        return
      }
      await handleTelegramLinked({ channels: data.channels })
    } catch {
      setTgError(ce.networkError)
    } finally {
      setTgLoading(false)
    }
  }

  const requestCode = async () => {
    setTgError('')
    setTgLoading(true)
    try {
      const phone = normalizeTelegramPhoneInput(tgPhone)
      const { ok, data } = await callTelegramAuth<TelegramCodeStatusResponse>(
        EDGE_FN,
        session?.access_token,
        'send_code',
        { phone },
      )
      if (!ok) {
        const msg = resolveTelegramAuthError(data.error, ce.failedSendCode, ce)
        setTgError(msg)
        return
      }
      setTgPhone(phone)
      setTgCodeDelivery(data.delivery ?? null)
      setTgNextCodeDelivery(data.next_delivery ?? null)
      setTgResendAvailableAt(resolveResendAvailableAt(data))
      setTgCanResendCode(Boolean(data.can_resend))
      setTgStage('code')
    } catch {
      setTgError(ce.networkError)
    } finally {
      setTgLoading(false)
    }
  }

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault()
    await requestCode()
  }

  const resendCode = async () => {
    setTgError('')
    setTgLoading(true)
    try {
      const phone = normalizeTelegramPhoneInput(tgPhone)
      const { ok, data } = await callTelegramAuth<TelegramCodeStatusResponse>(
        EDGE_FN,
        session?.access_token,
        'resend_code',
        { phone },
      )
      if (!ok) {
        setTgError(resolveTelegramAuthError(data.error, ce.failedSendCode, ce))
        return
      }
      setTgPhone(phone)
      setTgCodeDelivery(data.delivery ?? null)
      setTgNextCodeDelivery(data.next_delivery ?? null)
      setTgResendAvailableAt(resolveResendAvailableAt(data))
      setTgCanResendCode(Boolean(data.can_resend))
      setTgStage('code')
    } catch {
      setTgError(ce.networkError)
    } finally {
      setTgLoading(false)
    }
  }

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setTgError('')
    setTgLoading(true)
    try {
      const phone = normalizeTelegramPhoneInput(tgPhone)
      const code = normalizeTelegramCodeInput(tgCode)
      const { status: resStatus, data } = await callTelegramAuth<{
        requires_password?: boolean
        channels?: TgChannelListItem[]
      }>(EDGE_FN, session?.access_token, 'verify_code', {
        phone,
        code,
        password: tgStage === 'twoFa' ? tgPassword : undefined,
      })
      const res = { ok: resStatus >= 200 && resStatus < 300 }
      if (data.requires_password) {
        setTgPhone(phone)
        setTgCode(code)
        setTgStage('twoFa')
        setTgError('')
        return
      }
      if (!res.ok || data.error) {
        const msg = resolveTelegramAuthError(data.error, ce.verificationFailed, ce)
        setTgError(msg)
        if (isNoPendingPhoneAuthError(data.error)) {
          setTgPassword('')
          setTgStage('phone')
        }
        return
      }
      setTgPhone(phone)
      setTgCode(code)
      await handleTelegramLinked({ channels: data.channels as TgChannelListItem[] | undefined })
    } catch {
      setTgError(ce.networkError)
    } finally {
      setTgLoading(false)
    }
  }

  const disconnectTelegram = async () => {
    await clearTelegramConnection('idle')
  }

  const handleTgStageChange = (stage: TelegramConnectStage) => {
    if (stage === 'idle' && hasTgSession) {
      setTgStage('linked')
    } else {
      setTgStage(stage)
    }
    setTgError('')
    if (stage === 'phone' || stage === 'method') {
      setTgCode('')
      setTgCodeDelivery(null)
      setTgNextCodeDelivery(null)
      setTgResendAvailableAt(null)
      setTgPassword('')
      setTgQrUrl('')
      setTgQrWaiting(false)
    }
    if (stage === 'code') {
      setTgPassword('')
    }
    if (stage !== 'qr') {
      setTgQrWaiting(false)
    }
  }

  const showListenerLeaseWarning =
    hasTgSession
    && hasActiveSubscription
    && !isTgReconnectFlow
    && (listenerLease.status === 'expired' || listenerLease.status === 'missing')

  return (
    <PageShell maxWidth="lg" spacing="none" className="space-y-6">
      <PageHeader
        title={t.pages.copierEngine.title}
        subtitle={t.pages.copierEngine.description}
        actions={
          hasTgSession ? (
            <Button variant="secondary" size="sm" onClick={() => void fetchTgChannels({ force: true })} loading={loadingTg}>
              <RefreshCw className="w-3.5 h-3.5" />
              {t.common.refresh}
            </Button>
          ) : undefined
        }
      />

      {showListenerLeaseWarning && (
        <div className="mb-3 px-4 py-3 bg-warning-50 dark:bg-amber-950/40 border border-warning-200 dark:border-amber-800 rounded-xl text-sm text-warning-800 dark:text-amber-100 flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{ce.listenerLeaseExpired}</p>
              <p className="text-xs mt-0.5 opacity-90">{ce.listenerLeaseExpiredHint}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 sm:flex-shrink-0">
            <Button size="sm" variant="secondary" onClick={() => void fetchTgChannels({ force: true })} loading={loadingTg}>
              <RefreshCw className="w-3.5 h-3.5" />
              {t.common.refresh}
            </Button>
            <Button size="sm" onClick={() => void reconnectTelegram()}>
              {ce.reconnectTelegram}
            </Button>
          </div>
        </div>
      )}

      {/* Status row */}
      {/* {brokers.length === 0 && (
        <div className="mb-4 px-4 py-3 bg-warning-50 border border-warning-200 rounded-xl text-sm text-warning-700 flex items-center gap-2">
          <span className="font-medium">No active broker account.</span>
          <a href="/brokers" className="underline text-warning-800">Connect one in Brokers.</a>
        </div>
      )} */}
      {!loading && showTelegramConnectFlow && (
        <TelegramConnectFlow
          stage={tgStage === 'linked' ? 'idle' : tgStage}
          onStageChange={handleTgStageChange}
          authMethod={tgAuthMethod}
          onAuthMethodChange={setTgAuthMethod}
          phone={tgPhone}
          onPhoneChange={setTgPhone}
          code={tgCode}
          onCodeChange={setTgCode}
          password={tgPassword}
          onPasswordChange={setTgPassword}
          codeDelivery={tgCodeDelivery}
          nextCodeDelivery={tgNextCodeDelivery}
          resendAvailableAt={tgResendAvailableAt}
          canResend={tgCanResendCode}
          qrUrl={tgQrUrl}
          qrWaiting={tgQrWaiting}
          loading={tgLoading}
          error={tgError}
          onSendCode={sendCode}
          onResendCode={resendCode}
          onRequestNewCode={requestCode}
          onVerifyCode={verifyCode}
          onStartQr={startQrLogin}
          onVerifyQrPassword={verifyQrPassword}
        />
      )}

      {loading && !hasTgSession && (
        <Card className="mb-3" padding="none">
          <div className="px-4 py-6">
            <div className="h-4 w-48 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse mb-2" />
            <div className="h-3 w-64 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse" />
          </div>
        </Card>
      )}

      {/* Telegram channels panel */}
      {hasTgSession && !isTgReconnectFlow && (
        <Card className="mb-3" padding="none">
          <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between gap-2 bg-gradient-to-r from-[#229ED9]/8 to-transparent dark:from-[#229ED9]/15">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-white dark:bg-neutral-800 border border-neutral-100 dark:border-neutral-700 flex items-center justify-center flex-shrink-0 shadow-sm">
                <img src="/Telegram.svg" alt="" className="w-[18px] h-[18px] object-contain" loading="lazy" aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 truncate">{ce.yourTelegramChannels}</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{ce.telegramConnectedHint}</p>
              </div>
              <span className="flex-shrink-0 hidden sm:inline-flex gap-1.5">
                <Badge variant="primary" size="sm">{ce.connected}</Badge>
                {hasActiveSubscription && listenerLease.status === 'live' && (
                  <Badge variant="primary" size="sm">{ce.listenerLeaseLive}</Badge>
                )}
                {!hasActiveSubscription && listenerLease.status === 'live' && (
                  <Badge variant="warning" size="sm">{ce.listenerLeaseExpired}</Badge>
                )}
                {listenerLease.status === 'unknown' && (
                  <Badge variant="neutral" size="sm">{ce.listenerLeaseUnknown}</Badge>
                )}
                {(listenerLease.status === 'expired' || listenerLease.status === 'missing') && (
                  <Badge variant="warning" size="sm">{ce.listenerLeaseExpired}</Badge>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTgChannelsCollapsed(prev => !prev)}
                className="text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800 hover:text-neutral-700 dark:text-neutral-300"
              >
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${tgChannelsCollapsed ? '-rotate-90' : 'rotate-0'}`} />
                {tgChannelsCollapsed ? ce.expand : ce.collapse}
              </Button>
              <Button variant="ghost" size="sm" onClick={disconnectTelegram} className="text-error-600 hover:bg-error-50 hover:text-error-700">
                <AlertCircle className="w-3.5 h-3.5" />
                {ce.disconnect}
              </Button>
            {tgChannels.length > 0 && (
              <span className="text-xs text-neutral-400">
                {interpolate(ce.channelsFound, { count: String(tgChannels.length) })}
              </span>
            )}
            </div>
          </div>
          {!tgChannelsCollapsed && tgChannels.length > 0 && (
            <div className="px-4 py-2 border-b border-neutral-100 dark:border-neutral-800">
              <Input
                type="search"
                placeholder={ce.channelSearchPlaceholder}
                value={tgChannelSearch}
                onChange={e => setTgChannelSearch(e.target.value)}
                aria-label={ce.channelSearchPlaceholder}
              />
            </div>
          )}
          {!tgChannelsCollapsed && (loadingTg && tgChannels.length === 0 ? (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="px-4 py-2.5 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-neutral-100 dark:bg-neutral-800 animate-pulse flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-48" />
                    <div className="h-2.5 bg-neutral-100 dark:bg-neutral-800 rounded animate-pulse w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-error-300" />
              <p className="text-sm text-neutral-700 dark:text-neutral-300 font-medium">{error}</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => void fetchTgChannels({ force: true })} loading={loadingTg}>
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t.common.refresh}
                </Button>
                <Button size="sm" onClick={() => void reconnectTelegram()}>
                  {ce.reconnectTelegram}
                </Button>
              </div>
            </div>
          ) : tgChannels.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Radio className="w-8 h-8 mx-auto mb-2 text-neutral-200" />
              <p className="text-sm text-neutral-400">{ce.noTgChannelsTitle}</p>
              <p className="text-xs text-neutral-300 mt-0.5">{ce.noTgChannelsSubtitle}</p>
            </div>
          ) : filteredTgChannels.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-neutral-400">{ce.noChannelSearchResults}</p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800 max-h-72 overflow-y-auto">
              {filteredTgChannels.map(ch => {
                const alreadyAdded = channels.some(c => c.channel_id === ch.id)
                return (
                  <div key={ch.id} className="px-4 py-2.5 flex items-center gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors">
                    <TgChannelAvatar title={ch.title} username={ch.username} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{ch.title}</p>
                      {ch.username && <p className="text-xs text-neutral-400">@{ch.username}</p>}
                    </div>
                    {ch.members_count > 0 && (
                      <span className="text-xs text-neutral-400 flex-shrink-0">
                        {interpolate(ce.members, { count: ch.members_count.toLocaleString() })}
                      </span>
                    )}
                    <button
                      onClick={() => addFromTg(ch)}
                      className={`px-3 py-1 text-xs font-medium rounded-lg border transition-colors flex-shrink-0 ${
                        alreadyAdded
                          ? 'border-neutral-200 dark:border-neutral-800 text-neutral-400 cursor-default'
                          : 'border-primary-500 text-primary-600 hover:bg-primary-50'
                      }`}
                      disabled={alreadyAdded}
                    >
                      {alreadyAdded ? ce.added : ce.add}
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </Card>
      )}

      {/* Channel list */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-14 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-100 dark:border-neutral-800 animate-pulse" />)}
        </div>
      ) : channels.length === 0 ? (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 py-10 text-center">
          <Radio className="w-8 h-8 mx-auto mb-2 text-neutral-200" />
          <p className="text-sm font-medium text-neutral-400">{ce.configuredEmptyTitle}</p>
          <p className="text-xs text-neutral-300 mt-0.5 max-w-sm mx-auto">
            {!hasTgSession ? ce.configuredEmptyConnectHint : ce.configuredEmptySubtitle}
          </p>
        </div>
      ) : (
        <Card padding="none">
          <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{ce.activeChannels}</p>
            <span className="text-xs text-neutral-400">
              {interpolate(ce.configuredCount, { count: String(channels.length) })}
            </span>
          </div>
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {channels.map(channel => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                brokers={brokers}
                connectMenuOpen={connectMenuChannelId === channel.id}
                connectingBrokerId={connectingBrokerId}
                connectingAll={connectingAllChannelId === channel.id}
                disconnectingLinkKey={disconnectingLinkKey}
                onToggleConnectMenu={() => setConnectMenuChannelId(
                  connectMenuChannelId === channel.id ? null : channel.id,
                )}
                onCloseConnectMenu={() => setConnectMenuChannelId(null)}
                onConnectBroker={brokerId => void handleConnectChannelToBroker(channel.id, brokerId)}
                onConnectAllBrokers={() => void handleConnectAllBrokersToChannel(channel.id)}
                onDisconnectBroker={brokerId => void handleDisconnectChannelFromBroker(channel.id, brokerId)}
                onToggle={v => toggleChannel(channel.id, v)}
                onDelete={() => deleteChannel(channel.id)}
              />
            ))}
          </div>
        </Card>
      )}
    </PageShell>
  )
}

function ChannelRow({
  channel, brokers,
  connectMenuOpen, connectingBrokerId, connectingAll, disconnectingLinkKey,
  onToggleConnectMenu, onCloseConnectMenu, onConnectBroker, onConnectAllBrokers, onDisconnectBroker,
  onToggle, onDelete,
}: {
  channel: TelegramChannel
  brokers: BrokerAccount[]
  connectMenuOpen: boolean
  connectingBrokerId: string | null
  connectingAll: boolean
  disconnectingLinkKey: string | null
  onToggleConnectMenu: () => void
  onCloseConnectMenu: () => void
  onConnectBroker: (brokerId: string) => void
  onConnectAllBrokers: () => void
  onDisconnectBroker: (brokerId: string) => void
  onToggle: (v: boolean) => void
  onDelete: () => void
}) {
  const t = useT()
  const ce = t.copierEnginePage
  const username = channel.channel_username?.replace(/^@/, '') || undefined
  const menuRef = useRef<HTMLDivElement>(null)
  const connectedBrokers = useMemo(
    () => brokersMatchingChannel(brokers, channel.id),
    [brokers, channel.id],
  )
  const availableBrokers = useMemo(
    () => brokersNotMatchingChannel(brokers, channel.id),
    [brokers, channel.id],
  )
  const hasAnyBrokers = brokers.some(b => isBrokerCopyEnabled(b))
  const identityValid = hasValidTelegramChannelIdentity(channel)

  useEffect(() => {
    if (!connectMenuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onCloseConnectMenu()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [connectMenuOpen, onCloseConnectMenu])

  return (
    <div className={clsx(
      'hover:bg-neutral-50 dark:hover:bg-neutral-800/80 transition-colors',
      connectMenuOpen && 'relative z-20',
    )}>
      <div className="flex items-center gap-3 px-4 py-3">
        <TgChannelAvatar title={channel.display_name} username={username} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{channel.display_name}</h3>
            {!channel.is_active && <Badge variant="neutral" size="sm">{ce.statusPaused}</Badge>}
          </div>
          {!identityValid && (
            <p className="mt-1 text-xs text-warning-800 dark:text-amber-200">{ce.invalidChannelIdentity}</p>
          )}
          {username && <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">@{username}</p>}
          {isNumericTelegramChatId(channel.channel_id) && (
            <p className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500 font-mono">
              {interpolate(ce.channelTelegramId, { id: channel.channel_id })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Toggle checked={channel.is_active} onChange={onToggle} />
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-error-50 hover:text-error-600 transition-colors"
            aria-label={interpolate(ce.removeAria, { label: channel.display_name })}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/60 px-4 py-2.5 space-y-2.5">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 mb-1.5">{ce.connectedBrokers}</p>
          {connectedBrokers.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {connectedBrokers.map(broker => {
                const label = getBrokerDisplayLabel(broker)
                const linkKey = `${channel.id}:${broker.id}`
                const isDisconnecting = disconnectingLinkKey === linkKey
                return (
                  <Badge key={broker.id} variant="neutral" size="sm">
                    <span>{label}</span>
                    <button
                      type="button"
                      onClick={() => onDisconnectBroker(broker.id)}
                      disabled={isDisconnecting}
                      className="ml-0.5 -mr-0.5 rounded-full p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100 disabled:opacity-50 transition-colors"
                      aria-label={interpolate(ce.removeBrokerConnectionAria, {
                        broker: label,
                        channel: channel.display_name,
                      })}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                )
              })}
              {(availableBrokers.length > 0 || connectedBrokers.length > 0) && (
                <div className="relative" ref={menuRef}>
                  <button
                    type="button"
                    onClick={onToggleConnectMenu}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-white dark:hover:bg-neutral-900 transition-colors"
                    aria-label={interpolate(ce.addBrokerConnectionAria, { channel: channel.display_name })}
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  {connectMenuOpen && (
                    <div className="absolute left-0 top-full z-30 mt-1 min-w-[12rem] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1">
                      {!hasAnyBrokers ? (
                        <p className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{ce.noBrokersYet}</p>
                      ) : availableBrokers.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{ce.connectedBrokers}</p>
                      ) : (
                        availableBrokers.map(broker => (
                          <button
                            key={broker.id}
                            type="button"
                            disabled={connectingBrokerId === broker.id}
                            onClick={() => onConnectBroker(broker.id)}
                            className="w-full px-3 py-2 text-left text-sm text-neutral-800 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                          >
                            {getBrokerDisplayLabel(broker)}
                          </button>
                        ))
                      )}
                      <div className="border-t border-neutral-100 dark:border-neutral-800 mt-1 pt-1">
                        <Link
                          to="/brokers"
                          className="block px-3 py-2 text-xs text-primary-600 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                          onClick={onCloseConnectMenu}
                        >
                          {ce.connectBrokerInConfig}
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : hasAnyBrokers ? (
            <div className="flex flex-wrap items-center gap-2">
              {availableBrokers.length >= 2 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={connectingAll}
                  disabled={connectingBrokerId !== null}
                  onClick={onConnectAllBrokers}
                  aria-label={interpolate(ce.connectAllBrokersAria, { channel: channel.display_name })}
                >
                  {ce.connectAllBrokers}
                </Button>
              )}
              <div className="relative inline-block" ref={menuRef}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onToggleConnectMenu}
                loading={connectingBrokerId !== null && !connectingAll}
                disabled={connectingAll}
              >
                {ce.connectToBroker}
              </Button>
              {connectMenuOpen && availableBrokers.length > 0 && (
                <div className="absolute left-0 top-full z-30 mt-1 min-w-[12rem] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1">
                  {availableBrokers.map(broker => (
                    <button
                      key={broker.id}
                      type="button"
                      disabled={connectingBrokerId === broker.id}
                      onClick={() => onConnectBroker(broker.id)}
                      className="w-full px-3 py-2 text-left text-sm text-neutral-800 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
                    >
                      {getBrokerDisplayLabel(broker)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            </div>
          ) : (
            <Link
              to="/brokers"
              className="inline-flex items-center rounded-lg border border-dashed border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-xs font-medium text-primary-600 hover:bg-white dark:hover:bg-neutral-900 transition-colors"
            >
              {ce.connectToBroker}
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
