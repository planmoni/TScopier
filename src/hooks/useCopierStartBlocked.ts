import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useBrokerAccounts } from '../context/BrokerAccountsContext'
import { useSubscription } from '../context/SubscriptionContext'
import { isBrokerSessionConnected } from '../lib/brokerReconnect'
import { resolveCopierStartBlocked, type CopierStartBlockedReason } from '../lib/copierStartBlocked'
import { getCachedTgSession, setCachedTgSession } from '../lib/telegramSessionCache'
import { supabase } from '../lib/supabase'

export function useCopierStartBlocked() {
  const { user } = useAuth()
  const { hasActiveSubscription, usage, usageLoading, loading: subscriptionLoading } = useSubscription()
  const { brokers, loading: brokersLoading } = useBrokerAccounts()
  const [telegramConnected, setTelegramConnected] = useState<boolean | null>(() => {
    if (!user?.id) return null
    return getCachedTgSession(user.id)
  })
  const [telegramLoading, setTelegramLoading] = useState(() => user?.id ? telegramConnected === null : false)

  const refreshTelegramSession = useCallback(async () => {
    if (!user?.id) {
      setTelegramConnected(null)
      setTelegramLoading(false)
      return
    }
    setTelegramLoading(true)
    const { data } = await supabase
      .from('telegram_sessions')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
    const hasSession = !!data
    setTelegramConnected(hasSession)
    setCachedTgSession(user.id, hasSession)
    setTelegramLoading(false)
  }, [user?.id])

  useEffect(() => {
    void refreshTelegramSession()
  }, [refreshTelegramSession])

  const resolving = subscriptionLoading || usageLoading || brokersLoading || telegramLoading

  const hasConnectedBroker = useMemo(
    () => brokers.some(b => b.is_active !== false && isBrokerSessionConnected(b)),
    [brokers],
  )

  const { blocked, reason } = useMemo(
    () => resolveCopierStartBlocked({
      hasActiveSubscription,
      hasConnectedBroker,
      hasTelegramSession: telegramConnected === true,
      hasChannels: usage.telegramChannels > 0,
    }),
    [hasActiveSubscription, hasConnectedBroker, telegramConnected, usage.telegramChannels],
  )

  return {
    copierStartBlocked: blocked,
    copierStartBlockedReason: reason as CopierStartBlockedReason | null,
    missingBroker: blocked && reason === 'setup' && !hasConnectedBroker,
    missingTelegram: blocked && reason === 'setup' && !telegramConnected,
    missingChannels: blocked && reason === 'setup' && usage.telegramChannels === 0,
    resolving,
  }
}
