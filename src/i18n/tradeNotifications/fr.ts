import type { TradeNotificationsTranslations } from './types'

export const tradeNotificationsFr: TradeNotificationsTranslations = {
  headlines: {
    executionCompleted: 'EXÉCUTION DE TRADE TERMINÉE',
    modificationCompleted: 'MODIFICATION DE TRADE TERMINÉE',
    layeringCompleted: 'LAYERING TERMINÉ',
    tradesClosed: 'TRADES CLÔTURÉS',
    reviewRequired: 'SIGNAL EN ATTENTE D\'APPROBATION',
    manualOverrideReverted: 'Manual trade changes were reverted',
  },
  bodies: {
    executionBatch: '{count} trades {side} ont été ouverts sur {broker} via {channel}.',
    executionSingle: 'Un trade {side} a été ouvert sur {broker} via {channel}.',
    slModifiedFromTo:
      'Le SL est passé de {oldSl} à {newSl} sur votre trade {side} sur {broker} via {channel}.',
    slModifiedTo: 'Le SL a été mis à jour à {newSl} sur votre trade {side} sur {broker} via {channel}.',
    tpModifiedTo: 'Le TP a été mis à jour à {newTp} sur votre trade {side} sur {broker} via {channel}.',
    tpsModifiedTo: 'Les TPs ont été mis à jour à {tpList} sur votre trade {side} sur {broker} via {channel}.',
    slAndTpsModifiedTo:
      'Le SL a été mis à jour à {newSl} et les TPs à {tpList} sur votre trade {side} sur {broker} via {channel}.',
    modificationBatch: '{count} trades ont été mis à jour sur {broker} via {channel}.',
    tpsModificationBatch: 'Les TPs ont été mis à jour sur {count} trades {side} sur {broker} via {channel}.',
    layeringBatch: '{count} ordres en layering ont été exécutés sur {broker} via {channel}.',
    layeringSingle: 'Un ordre en layering a été exécuté sur {broker} via {channel}.',
    tradesClosedTp: '{count} trades ont été clôturés sur {broker} en raison de {reason} via {channel}.',
    tradesClosedGeneric: '{count} trades ont été clôturés sur {broker} via {channel}.',
    tradesClosedSingle: 'Un trade a été clôturé sur {broker} via {channel}.',
    reviewRequired: 'Un signal de {channel} attend votre approbation.',
    manualOverrideReverted: 'TScopier detected a manual SL/TP change made directly on your broker account and restored the signal managed values. To change SL or TP for a copied signal, use Manage Signal in TScopier.',
  },
  sides: {
    buy: 'achat',
    sell: 'vente',
    trade: 'trade',
  },
  fallbacks: {
    broker: 'votre compte',
    channel: 'votre canal',
  },
  actions: {
    manageSignal: 'Manage Signal',
  },
  tpReason: 'TP{index}',
}
