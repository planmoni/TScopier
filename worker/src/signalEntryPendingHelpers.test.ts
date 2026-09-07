import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  findClosedRowForTicket,
  isLikelyMarketPositionRow,
  isPendingEntryRow,
  readBrokerOrderStopLoss,
  readBrokerOrderTakeProfit,
} from './signalEntryPendingHelpers'

test('readBrokerOrderStopLoss reads FxSocket camelCase stopLoss', () => {
  assert.equal(readBrokerOrderStopLoss({ stopLoss: 4123.5 }), 4123.5)
  assert.equal(readBrokerOrderStopLoss({ StopLoss: '4010' }), 4010)
  assert.equal(readBrokerOrderStopLoss({ sl: 0 }), null)
  assert.equal(readBrokerOrderStopLoss({}), null)
})

test('isPendingEntryRow: operation strings', () => {
  assert.equal(isPendingEntryRow({ operation: 'BuyLimit' }), true)
  assert.equal(isPendingEntryRow({ Operation: 'Sell Stop' }), true)
  assert.equal(isPendingEntryRow({ operation: 'Buy' }), false)
})

test('isPendingEntryRow: numeric MT4-style types 2–5', () => {
  assert.equal(isPendingEntryRow({ type: 2 }), true)
  assert.equal(isPendingEntryRow({ Type: '3' }), true)
  assert.equal(isPendingEntryRow({ orderType: 5 }), true)
  assert.equal(isPendingEntryRow({ cmd: 4 }), true)
})

test('isPendingEntryRow: market types 0–1 are not pending', () => {
  assert.equal(isPendingEntryRow({ type: 0, operation: 'Buy' }), false)
  assert.equal(isPendingEntryRow({ type: 1 }), false)
})

test('isLikelyMarketPositionRow: rejects pendings', () => {
  assert.equal(isLikelyMarketPositionRow({ type: 2 }), false)
  assert.equal(isLikelyMarketPositionRow({ operation: 'BuyLimit' }), false)
})

test('isLikelyMarketPositionRow: buy/sell positions', () => {
  assert.equal(isLikelyMarketPositionRow({ operation: 'Buy' }), true)
  assert.equal(isLikelyMarketPositionRow({ Operation: 'Sell' }), true)
  assert.equal(isLikelyMarketPositionRow({ type: 0 }), true)
  assert.equal(isLikelyMarketPositionRow({ type: 1 }), true)
})

test('findClosedRowForTicket: returns brokerTicket', () => {
  const closed = [{ ticket: 999888, openPrice: 2650.1, state: 'filled' }]
  const c = findClosedRowForTicket(closed as unknown[], 999888)
  assert.ok(c)
  assert.equal(c!.brokerTicket, 999888)
  assert.equal(c!.openPrice, 2650.1)
})

test('readBrokerOrderTakeProfit reads FxSocket camelCase takeProfit', () => {
  assert.equal(readBrokerOrderTakeProfit({ takeProfit: 4123.5 }), 4123.5)
  assert.equal(readBrokerOrderTakeProfit({ TakeProfit: '4010' }), 4010)
  assert.equal(readBrokerOrderTakeProfit({ tp: 0 }), null)
  assert.equal(readBrokerOrderTakeProfit({}), null)
})