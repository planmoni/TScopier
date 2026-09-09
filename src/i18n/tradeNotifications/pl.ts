import type { TradeNotificationsTranslations } from './types'

export const tradeNotificationsPl: TradeNotificationsTranslations = {
  headlines: {
    executionCompleted: 'WYKONANIE TRANSAKCJI ZAKOŃCZONE',
    modificationCompleted: 'MODYFIKACJA TRANSAKCJI ZAKOŃCZONA',
    layeringCompleted: 'LAYERING ZAKOŃCZONY',
    tradesClosed: 'CZĘŚĆ TRANSAKCJI ZAMKNIĘTA',
    reviewRequired: 'SYGNAŁ OCZEKUJĄCY NA ZATWIERDZENIE',
    manualOverrideReverted: 'Manual trade changes were reverted',
  },
  bodies: {
    executionBatch: 'Otwarto {count} transakcji {side} na {broker} z {channel}.',
    executionSingle: 'Otwarto transakcję {side} na {broker} z {channel}.',
    slModifiedFromTo:
      'SL został zmieniony z {oldSl} na {newSl} w Twojej transakcji {side} na {broker} z {channel}.',
    slModifiedTo: 'SL został zaktualizowany do {newSl} w Twojej transakcji {side} na {broker} z {channel}.',
    tpModifiedTo: 'TP został zaktualizowany do {newTp} w Twojej transakcji {side} na {broker} z {channel}.',
    tpsModifiedTo: 'TP zostały zaktualizowane do {tpList} w Twojej transakcji {side} na {broker} z {channel}.',
    slAndTpsModifiedTo:
      'SL został zaktualizowany do {newSl}, a TP do {tpList} w Twojej transakcji {side} na {broker} z {channel}.',
    modificationBatch: 'Zaktualizowano {count} transakcji na {broker} z {channel}.',
    tpsModificationBatch: 'TP zostały zaktualizowane w {count} transakcjach {side} na {broker} z {channel}.',
    layeringBatch: 'Wykonano {count} zleceń warstwowych na {broker} z {channel}.',
    layeringSingle: 'Wykonano zlecenie warstwowe na {broker} z {channel}.',
    tradesClosedTp: 'Zamknięto {count} transakcji na {broker} z powodu {reason} z {channel}.',
    tradesClosedGeneric: 'Zamknięto {count} transakcji na {broker} z {channel}.',
    tradesClosedSingle: 'Zamknięto transakcję na {broker} z {channel}.',
    reviewRequired: 'Sygnał z {channel} oczekuje na Twoją akceptację.',
    manualOverrideReverted: 'TScopier detected a manual SL/TP change made directly on your broker account and restored the signal managed values. To change SL or TP for a copied signal, use Manage Signal in TScopier.',
  },
  sides: {
    buy: 'kupna',
    sell: 'sprzedaży',
    trade: 'transakcji',
  },
  fallbacks: {
    broker: 'Twoim koncie',
    channel: 'Twojego kanału',
  },
  actions: {
    manageSignal: 'Manage Signal',
  },
  tpReason: 'TP{index}',
}
