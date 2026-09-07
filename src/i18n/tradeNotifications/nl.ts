import type { TradeNotificationsTranslations } from './types'

export const tradeNotificationsNl: TradeNotificationsTranslations = {
  headlines: {
    executionCompleted: 'TRADE-UITVOERING VOLTOOID',
    modificationCompleted: 'TRADE-WIJZIGING VOLTOOID',
    layeringCompleted: 'LAYERING VOLTOOID',
    tradesClosed: 'SOMMIGE TRADES GESLOTEN',
    reviewRequired: 'SIGNAAL WACHT OP GOEDKEURING',
    manualOverrideReverted: 'Manual trade changes were reverted',
  },
  bodies: {
    executionBatch: 'Er zijn {count} {side}-trades geopend in {broker} vanuit {channel}.',
    executionSingle: 'Er is een {side}-trade geopend in {broker} vanuit {channel}.',
    slModifiedFromTo: 'SL is aangepast van {oldSl} naar {newSl} op je {side}-trade in {broker} vanuit {channel}.',
    slModifiedTo: 'SL is bijgewerkt naar {newSl} op je {side}-trade in {broker} vanuit {channel}.',
    tpModifiedTo: 'TP is bijgewerkt naar {newTp} op je {side}-trade in {broker} vanuit {channel}.',
    tpsModifiedTo: 'TP\'s zijn bijgewerkt naar {tpList} op je {side}-trade in {broker} vanuit {channel}.',
    slAndTpsModifiedTo:
      'SL is bijgewerkt naar {newSl} en TP\'s naar {tpList} op je {side}-trade in {broker} vanuit {channel}.',
    modificationBatch: '{count} trades zijn bijgewerkt in {broker} vanuit {channel}.',
    tpsModificationBatch: 'TP\'s zijn bijgewerkt op {count} {side}-trades in {broker} vanuit {channel}.',
    layeringBatch: '{count} gelaagde orders zijn uitgevoerd in {broker} vanuit {channel}.',
    layeringSingle: 'Een gelaagde order is uitgevoerd in {broker} vanuit {channel}.',
    tradesClosedTp: '{count} trades zijn gesloten in {broker} vanwege {reason} vanuit {channel}.',
    tradesClosedGeneric: '{count} trades zijn gesloten in {broker} vanuit {channel}.',
    tradesClosedSingle: 'Een trade is gesloten in {broker} vanuit {channel}.',
    reviewRequired: 'Een signaal van {channel} wacht op uw goedkeuring.',
    manualOverrideReverted: 'TScopier detected a manual SL/TP change made directly on your broker account and restored the signal managed values. To change SL or TP for a copied signal, use Manage Signal in TScopier.',
  },
  sides: {
    buy: 'koop',
    sell: 'verkoop',
    trade: 'trade',
  },
  fallbacks: {
    broker: 'je account',
    channel: 'je kanaal',
  },
  actions: {
    manageSignal: 'Manage Signal',
  },
  tpReason: 'TP{index}',
}
