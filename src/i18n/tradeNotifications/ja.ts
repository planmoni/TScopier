import type { TradeNotificationsTranslations } from './types'

export const tradeNotificationsJa: TradeNotificationsTranslations = {
  headlines: {
    executionCompleted: '取引執行が完了しました',
    modificationCompleted: '取引変更が完了しました',
    layeringCompleted: 'レイヤリングが完了しました',
    tradesClosed: '一部の取引が決済されました',
    reviewRequired: '承認待ちのシグナル',
    manualOverrideReverted: 'Manual trade changes were reverted',
  },
  bodies: {
    executionBatch: '{channel}から{broker}で{side}の取引が{count}件新規建玉されました。',
    executionSingle: '{channel}から{broker}で{side}の取引が1件新規建玉されました。',
    slModifiedFromTo: '{channel}から{broker}での{side}取引のSLが{oldSl}から{newSl}に変更されました。',
    slModifiedTo: '{channel}から{broker}での{side}取引のSLが{newSl}に更新されました。',
    tpModifiedTo: '{channel}から{broker}での{side}取引のTPが{newTp}に更新されました。',
    tpsModifiedTo: '{channel}から{broker}での{side}取引のTPが{tpList}に更新されました。',
    slAndTpsModifiedTo: '{channel}から{broker}での{side}取引のSLが{newSl}に、TPが{tpList}に更新されました。',
    modificationBatch: '{channel}から{broker}で{count}件の取引が更新されました。',
    tpsModificationBatch: '{channel}から{broker}で{count}件の{side}取引のTPが更新されました。',
    layeringBatch: '{channel}から{broker}でレイヤリング注文が{count}件約定しました。',
    layeringSingle: '{channel}から{broker}でレイヤリング注文が1件約定しました。',
    tradesClosedTp: '{channel}から{broker}で{reason}により{count}件の取引が決済されました。',
    tradesClosedGeneric: '{channel}から{broker}で{count}件の取引が決済されました。',
    tradesClosedSingle: '{channel}から{broker}で取引が1件決済されました。',
    reviewRequired: '{channel}からのシグナルが承認待ちです。',
    manualOverrideReverted: 'TScopier detected a manual SL/TP change made directly on your broker account and restored the signal managed values. To change SL or TP for a copied signal, use Manage Signal in TScopier.',
  },
  sides: {
    buy: '買い',
    sell: '売り',
    trade: '取引',
  },
  fallbacks: {
    broker: 'あなたの口座',
    channel: 'あなたのチャンネル',
  },
  actions: {
    manageSignal: 'Manage Signal',
  },
  tpReason: 'TP{index}',
}
