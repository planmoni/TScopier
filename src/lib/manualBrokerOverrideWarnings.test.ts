import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MtTrade } from './fxsocketBroker'
import {
  buildManualBrokerOverrideWarningMaps,
  getManualBrokerOverrideWarningForTrade,
  manualOverrideManageSignalUrl,
} from './manualBrokerOverrideWarnings'
import { ManualBrokerOverrideWarningNotice } from '../components/trades/ManualBrokerOverrideWarning'

function mtTrade(ticket: number, overrides: Partial<MtTrade> = {}): MtTrade {
  return {
    id: `broker-trade-${ticket}`,
    broker_id: 'broker-1',
    broker_label: 'Main broker',
    broker_name: 'Main broker',
    ticket,
    position_ticket: ticket,
    symbol: 'XAUUSD',
    direction: 'buy',
    type: 'buy',
    lot_size: 0.01,
    entry_price: 4000,
    sl: 3990,
    tp: 4020,
    close_price: null,
    profit: null,
    swap: null,
    commission: null,
    comment: '',
    magic: null,
    opened_at: '2026-09-07T10:00:00.000Z',
    closed_at: null,
    state: 'open',
    status: 'open',
    ...overrides,
  } as MtTrade
}

describe('manual broker override contextual warnings', () => {
  it('maps a successful event to the affected broker trade and Manage Signal link', () => {
    const maps = buildManualBrokerOverrideWarningMaps([
      {
        id: 'log-1',
        created_at: '2026-09-07T10:05:00.000Z',
        signal_id: 'signal-1',
        broker_account_id: 'broker-1',
        request_payload: {
          anchor_signal_id: 'signal-1',
          symbol: 'XAUUSD',
          restored_trade_ids: ['trade-1'],
          changed_sides: ['sl'],
          manage_signal_url: '/manage-signals?edit=signal-1',
          cta_label: 'Manage Signal',
        },
      },
    ], [
      {
        id: 'trade-1',
        signal_id: 'signal-1',
        broker_account_id: 'broker-1',
        metaapi_order_id: '1001',
        symbol: 'XAUUSD',
      },
    ])

    const warning = getManualBrokerOverrideWarningForTrade(maps, mtTrade(1001), 'signal-1')
    expect(warning?.title).toBe('Manual broker changes were reverted')
    expect(warning?.body).toContain('restored this signal\'s managed values')
    expect(warning?.actionLabel).toBe('Manage Signal')
    expect(warning?.actionUrl).toBe('/manage-signals?edit=signal-1')
  })

  it('shows one contextual warning for a multi-leg basket incident', () => {
    const maps = buildManualBrokerOverrideWarningMaps([
      {
        id: 'log-1',
        created_at: '2026-09-07T10:05:00.000Z',
        signal_id: 'signal-1',
        broker_account_id: 'broker-1',
        request_payload: {
          anchor_signal_id: 'signal-1',
          symbol: 'XAUUSD',
          restored_trade_ids: ['trade-1', 'trade-2', 'trade-3'],
          changed_sides: ['sl', 'tp'],
        },
      },
    ], [
      { id: 'trade-1', signal_id: 'signal-1', broker_account_id: 'broker-1', metaapi_order_id: '1001', symbol: 'XAUUSD' },
      { id: 'trade-2', signal_id: 'signal-1', broker_account_id: 'broker-1', metaapi_order_id: '1002', symbol: 'XAUUSD' },
      { id: 'trade-3', signal_id: 'signal-1', broker_account_id: 'broker-1', metaapi_order_id: '1003', symbol: 'XAUUSD' },
    ])

    const warnings = [1001, 1002, 1003]
      .map(ticket => getManualBrokerOverrideWarningForTrade(maps, mtTrade(ticket), 'signal-1'))
      .filter(Boolean)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.id).toBe('log-1')
  })

  it('renders warning copy and CTA without relying on notification bell rendering', () => {
    const html = renderToStaticMarkup(React.createElement(ManualBrokerOverrideWarningNotice, {
      warning: {
        id: 'log-1',
        createdAt: '2026-09-07T10:05:00.000Z',
        signalId: 'signal-1',
        brokerAccountId: 'broker-1',
        symbol: 'XAUUSD',
        title: 'Manual broker changes were reverted',
        body: "TScopier detected an SL/TP change made directly on your broker account and restored this signal's managed values. To change SL or TP, use Manage Signal.",
        actionLabel: 'Manage Signal',
        actionUrl: manualOverrideManageSignalUrl('signal-1'),
        restoredTradeIds: ['trade-1'],
        changedSides: ['sl'],
      },
      onManageSignal: () => {},
    }))

    expect(html).toContain('Manual broker changes were reverted')
    expect(html).toContain('TScopier detected an SL/TP change made directly on your broker account')
    expect(html).toContain('Manage Signal')
  })

  it('builds fallback Manage Signal route when no signal id exists', () => {
    expect(manualOverrideManageSignalUrl(null)).toBe('/manage-signals')
  })
})
