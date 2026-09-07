export interface TradeNotificationsTranslations {
  headlines: {
    executionCompleted: string
    modificationCompleted: string
    layeringCompleted: string
    tradesClosed: string
    reviewRequired: string
    manualOverrideReverted: string
  }
  bodies: {
    executionBatch: string
    executionSingle: string
    slModifiedFromTo: string
    slModifiedTo: string
    tpModifiedTo: string
    tpsModifiedTo: string
    slAndTpsModifiedTo: string
    modificationBatch: string
    tpsModificationBatch: string
    layeringBatch: string
    layeringSingle: string
    tradesClosedTp: string
    tradesClosedGeneric: string
    tradesClosedSingle: string
    reviewRequired: string
    manualOverrideReverted: string
  }
  sides: {
    buy: string
    sell: string
    trade: string
  }
  fallbacks: {
    broker: string
    channel: string
  }
  actions: {
    manageSignal: string
  }
  tpReason: string
}
