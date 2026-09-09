import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tradeNotificationsEn } from '../i18n/tradeNotifications/en'
import {
  aggregateTradeNotificationEvents,
  countUnreadNotifications,
  formatHolisticNotification,
  reviewNotificationFromSignal,
  tradeNotificationsFromLogs,
  type ReviewRequiredSignal,
  type TradeExecutionLogRow,
  type TradeNotification,
} from './tradeNotifications'

const CHANNEL_ID = 'ch-1'
const BROKER_ID = 'broker-1'
const SIGNAL_ID = 'sig-1'

const ctx = {
  channelDisplayNames: { [CHANNEL_ID]: 'Mo channel' },
  brokerLabels: { [BROKER_ID]: 'My Broker' },
}

function baseRow(overrides: Partial<TradeExecutionLogRow> & Pick<TradeExecutionLogRow, 'id' | 'action'>): TradeExecutionLogRow {
  return {
    created_at: '2026-06-05T12:00:00.000Z',
    status: 'success',
    request_payload: {},
    response_payload: null,
    error_message: null,
    signal_id: SIGNAL_ID,
    broker_account_id: BROKER_ID,
    signals: {
      channel_id: CHANNEL_ID,
      parsed_data: { action: 'sell', symbol: 'XAUUSD' },
    },
    ...overrides,
  }
}

describe('aggregateTradeNotificationEvents', () => {
  it('aggregates 33 order_send rows into one execution_completed with count 33', () => {
    const rows = Array.from({ length: 33 }, (_, i) =>
      baseRow({
        id: `exec-${i}`,
        action: 'order_send',
        created_at: `2026-06-05T12:00:0${String(i).padStart(2, '0')}.000Z`,
        request_payload: { operation: 'sell' },
      }),
    )
    const events = aggregateTradeNotificationEvents(rows)
    const exec = events.filter(e => e.headline === 'execution_completed')
    assert.equal(exec.length, 1)
    assert.equal(exec[0].count, 33)
    assert.equal(exec[0].side, 'sell')
  })

  it('suppresses per-leg modifies when merge_modify_summary exists', () => {
    const rows = [
      baseRow({
        id: 'leg-1',
        action: 'mgmt_modify',
        created_at: '2026-06-05T12:00:01.000Z',
      }),
      baseRow({
        id: 'leg-2',
        action: 'merge_routed_modify_only',
        created_at: '2026-06-05T12:00:02.000Z',
      }),
      baseRow({
        id: 'summary',
        action: 'merge_modify_summary',
        created_at: '2026-06-05T12:00:03.000Z',
        request_payload: { modified: 5, symbol: 'XAUUSD' },
      }),
    ]
    const events = aggregateTradeNotificationEvents(rows)
    const mods = events.filter(e => e.headline === 'modification_completed')
    assert.equal(mods.length, 1)
    assert.equal(mods[0].id, 'summary')
    assert.equal(mods[0].count, 5)
  })

  it('groups partial_tp_fired by tp_idx with TP reason', () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      baseRow({
        id: `tp-${i}`,
        action: 'partial_tp_fired',
        created_at: `2026-06-05T12:00:0${i}.000Z`,
        request_payload: { tp_idx: 1 },
      }),
    )
    const events = aggregateTradeNotificationEvents(rows)
    const closed = events.filter(e => e.headline === 'trades_closed')
    assert.equal(closed.length, 1)
    assert.equal(closed[0].count, 4)
    assert.equal(closed[0].closeReason, 'TP1')
  })

  it('classifies virtual_pending_fired as layering', () => {
    const rows = [
      baseRow({ id: 'layer-1', action: 'virtual_pending_fired' }),
      baseRow({ id: 'layer-2', action: 'virtual_pending_fired', created_at: '2026-06-05T12:00:01.000Z' }),
    ]
    const events = aggregateTradeNotificationEvents(rows)
    assert.equal(events.length, 1)
    assert.equal(events[0].headline, 'layering_completed')
    assert.equal(events[0].count, 2)
  })

  it('ignores automated trailing_stop monitor logs', () => {
    const rows = [
      baseRow({ id: 'trail-1', action: 'trailing_stop', request_payload: { new_sl: 4500 } }),
      baseRow({ id: 'trail-2', action: 'trailing_stop', created_at: '2026-06-05T12:00:01.000Z' }),
    ]
    assert.equal(aggregateTradeNotificationEvents(rows).length, 0)
  })

  it('ignores pipeline and non-success logs', () => {
    const rows = [
      baseRow({ id: 'pipe', action: 'pipeline_parse_dispatch' }),
      baseRow({ id: 'fail', action: 'order_send', status: 'failed' }),
      baseRow({ id: 'skip', action: 'order_send', status: 'skipped' }),
    ]
    assert.equal(aggregateTradeNotificationEvents(rows).length, 0)
  })

  it('returns execution and modification when both exist', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        baseRow({
          id: `exec-${i}`,
          action: 'order_send',
          created_at: `2026-06-05T12:00:0${i}.000Z`,
          request_payload: { operation: 'buy' },
        }),
      ),
      baseRow({
        id: 'mod-1',
        action: 'merge_modify_summary',
        created_at: '2026-06-05T12:00:10.000Z',
        request_payload: { modified: 3 },
      }),
      baseRow({
        id: 'close-1',
        action: 'partial_tp_fired',
        created_at: '2026-06-05T12:00:20.000Z',
        request_payload: { tp_idx: 1 },
      }),
    ]
    const events = aggregateTradeNotificationEvents(rows)
    const headlines = events.map(e => e.headline).sort()
    assert.deepEqual(headlines, ['execution_completed', 'modification_completed', 'trades_closed'])
  })
})

describe('formatHolisticNotification', () => {
  it('formats TP levels from parsed signal on merge_modify_summary', () => {
    const rows = [
      baseRow({
        id: 'summary',
        action: 'merge_modify_summary',
        request_payload: { modified: 7, symbol: 'XAUUSD' },
        signals: {
          channel_id: CHANNEL_ID,
          parsed_data: { action: 'buy', symbol: 'XAUUSD', tp: [4220, 4230, 4240, 4245] },
        },
      }),
    ]
    const notification = tradeNotificationsFromLogs(rows, tradeNotificationsEn, ctx)[0]
    assert.equal(notification.title, 'TRADE MODIFICATION COMPLETED')
    assert.match(notification.body, /TPs were updated to 4220, 4230, 4240, 4245/)
  })

  it('formats SL and TP together when both are in parsed signal', () => {
    const rows = [
      baseRow({
        id: 'summary',
        action: 'merge_modify_summary',
        request_payload: { modified: 3, symbol: 'XAUUSD' },
        signals: {
          channel_id: CHANNEL_ID,
          parsed_data: { action: 'buy', symbol: 'XAUUSD', sl: 4175, tp: [4220, 4230] },
        },
      }),
    ]
    const notification = tradeNotificationsFromLogs(rows, tradeNotificationsEn, ctx)[0]
    assert.match(notification.body, /SL was updated to 4175/)
    assert.match(notification.body, /TPs to 4220, 4230/)
  })

  it('formats single TP from basket_leg_modify target_tp', () => {
    const rows = [
      baseRow({
        id: 'leg-1',
        action: 'basket_leg_modify',
        request_payload: { target_tp: 4220, operation: 'buy' },
        signals: {
          channel_id: CHANNEL_ID,
          parsed_data: { action: 'buy', symbol: 'XAUUSD' },
        },
      }),
    ]
    const notification = tradeNotificationsFromLogs(rows, tradeNotificationsEn, ctx)[0]
    assert.match(notification.body, /TP was updated to 4220/)
  })

  it('formats SL from/to when payload includes old_sl and new_sl', () => {
    const event = aggregateTradeNotificationEvents([
      baseRow({
        id: 'mod-1',
        action: 'mgmt_modify',
        request_payload: { old_sl: 4505, new_sl: 4503, operation: 'sell' },
      }),
    ])[0]

    const notification = formatHolisticNotification(event, tradeNotificationsEn, ctx)
    assert.equal(notification.title, 'TRADE MODIFICATION COMPLETED')
    assert.match(notification.body, /4505/)
    assert.match(notification.body, /4503/)
    assert.match(notification.body, /My Broker/)
    assert.match(notification.body, /Mo channel/)
  })

  it('formats execution batch message', () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      baseRow({
        id: `e-${i}`,
        action: 'order_send',
        request_payload: { operation: 'buy' },
      }),
    )
    const notification = tradeNotificationsFromLogs(rows, tradeNotificationsEn, ctx)[0]
    assert.equal(notification.title, 'TRADE EXECUTION COMPLETED')
    assert.match(notification.body, /3 buy trades were opened/)
    assert.match(notification.body, /My Broker/)
  })

  it('formats trades closed with TP reason', () => {
    const rows = [
      baseRow({
        id: 'c-1',
        action: 'partial_tp_fired',
        request_payload: { tp_idx: 2 },
      }),
    ]
    const notification = tradeNotificationsFromLogs(rows, tradeNotificationsEn, ctx)[0]
    assert.equal(notification.title, 'SOME TRADES CLOSED')
    assert.match(notification.body, /TP2/)
  })
})

describe('countUnreadNotifications', () => {
  const items: TradeNotification[] = [
    {
      id: 'a',
      headline: 'execution_completed',
      title: 'TRADE EXECUTION COMPLETED',
      body: 'Opened',
      symbol: 'XAUUSD',
      createdAt: '2026-06-05T12:00:00.000Z',
    },
    {
      id: 'b',
      headline: 'trades_closed',
      title: 'SOME TRADES CLOSED',
      body: 'Closed',
      symbol: 'XAUUSD',
      createdAt: '2026-06-05T13:00:00.000Z',
    },
  ]

  it('counts all when never read', () => {
    assert.equal(countUnreadNotifications(items, null), 2)
  })

  it('counts only items after last read timestamp', () => {
    assert.equal(countUnreadNotifications(items, '2026-06-05T12:30:00.000Z'), 1)
  })
})

describe('reviewNotificationFromSignal', () => {
  it('builds a review_required notification with the channel label and symbol', () => {
    const signal: ReviewRequiredSignal = {
      id: 'rev-1',
      created_at: '2026-06-05T12:34:00.000Z',
      channel_id: CHANNEL_ID,
      parsed_data: { action: 'sell', symbol: 'XAUUSD', tp: [30] },
      status: 'skipped',
      skip_reason: 'ai classified as uncertain; human review required',
    }
    const item = reviewNotificationFromSignal(signal, tradeNotificationsEn, ctx)
    assert.equal(item.id, 'review_required:rev-1')
    assert.equal(item.headline, 'review_required')
    assert.equal(item.title, 'SIGNAL AWAITING APPROVAL')
    assert.equal(item.body, 'A signal from Mo channel is waiting for your approval.')
    assert.equal(item.symbol, 'XAUUSD')
    assert.equal(item.createdAt, '2026-06-05T12:34:00.000Z')
  })

  it('falls back to channel placeholder and no symbol when unknown', () => {
    const item = reviewNotificationFromSignal(
      {
        id: 'rev-2',
        created_at: '2026-06-05T12:34:00.000Z',
        channel_id: null,
        parsed_data: null,
        status: 'skipped',
        skip_reason: null,
      },
      tradeNotificationsEn,
      ctx,
    )
    assert.equal(item.body, 'A signal from your channel is waiting for your approval.')
    assert.equal(item.symbol, null)
  })
})

describe('manual broker override warning notifications', () => {
  it('formats manual broker override warning with Manage Signal CTA link and dedupes the basket event', () => {
    const rows = [
      baseRow({
        id: 'manual-1',
        action: 'broker_manual_stop_override_reverted',
        signal_id: 'anchor-1',
        request_payload: {
          anchor_signal_id: 'anchor-1',
          symbol: 'XAUUSD',
          manage_signal_url: '/manage-signals?edit=anchor-1',
          cta_label: 'Manage Signal',
        },
      }),
      baseRow({
        id: 'manual-2',
        action: 'broker_manual_stop_override_reverted',
        signal_id: 'anchor-1',
        created_at: '2026-06-05T12:00:01.000Z',
        request_payload: {
          anchor_signal_id: 'anchor-1',
          symbol: 'XAUUSD',
          manage_signal_url: '/manage-signals?edit=anchor-1',
          cta_label: 'Manage Signal',
        },
      }),
    ]
    const notifications = tradeNotificationsFromLogs(rows, tradeNotificationsEn, ctx)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]!.headline, 'manual_override_reverted')
    assert.equal(notifications[0]!.title, 'Manual trade changes were reverted')
    assert.equal(notifications[0]!.actionUrl, '/manage-signals?edit=anchor-1')
    assert.equal(notifications[0]!.actionLabel, 'Manage Signal')
  })
})