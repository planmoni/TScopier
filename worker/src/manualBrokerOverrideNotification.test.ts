import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MANUAL_BROKER_OVERRIDE_REVERTED_ACTION,
  detectManualBrokerStopOverrides,
  detectManualBrokerStopOverridesDetailed,
  isDriftSweepReconcileJob,
  manageSignalPath,
  passiveDriftSweepSnapshot,
  notifyManualBrokerOverrideReverted,
  type ManualBrokerStopOverride,
} from './manualBrokerOverrideNotification'
import type { BasketOpenLeg, BasketReconcileJobRow } from './basketSlTpReconcile'

type InsertCall = { table: string; payload: Record<string, unknown> }

function leg(id: string, ticket: number, overrides: Partial<BasketOpenLeg> = {}): BasketOpenLeg {
  return {
    id,
    signal_id: 'anchor-1',
    metaapi_order_id: String(ticket),
    opened_at: '2026-09-06T10:00:00.000Z',
    lot_size: 0.05,
    sl: 3990,
    tp: 4020,
    entry_price: 4000,
    direction: 'buy',
    symbol: 'XAUUSD',
    ...overrides,
  }
}

function makeSupabase(existingNotifications: unknown[] = []) {
  const inserts: InsertCall[] = []
  const queries: Array<{ table: string; filters: Array<[string, unknown]> }> = []
  function builder(table: string) {
    const filters: Array<[string, unknown]> = []
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = (key: string, value: unknown) => { filters.push([key, value]); return b }
    b.gte = (key: string, value: unknown) => { filters.push([key, value]); return b }
    b.order = () => b
    b.limit = () => {
      queries.push({ table, filters })
      return Promise.resolve({ data: existingNotifications, error: null })
    }
    b.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload })
      return Promise.resolve({ data: null, error: null })
    }
    return b
  }
  return { supabase: { from: (table: string) => builder(table) }, inserts, queries }
}

let oldFetch: typeof globalThis.fetch | undefined
let oldUrl: string | undefined
let oldKey: string | undefined

beforeEach(() => {
  oldFetch = globalThis.fetch
  oldUrl = process.env.SUPABASE_URL
  oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.SUPABASE_URL = 'https://sso.example.test/'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
})

afterEach(() => {
  globalThis.fetch = oldFetch!
  if (oldUrl === undefined) delete process.env.SUPABASE_URL
  else process.env.SUPABASE_URL = oldUrl
  if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
  else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey
})

describe('detectManualBrokerStopOverrides', () => {
  it('detects broker-side SL drift only when DB already matches the managed target', () => {
    const overrides = detectManualBrokerStopOverrides({
      familyTrades: [leg('trade-1', 1001)],
      perLegTargets: [{ stoploss: 3990, takeprofit: 4020 }],
      ordersByTicket: new Map([[1001, { ticket: 1001, stopLoss: 3980, takeProfit: 4020 }]]),
      nImmCwe: 0,
    })

    assert.equal(overrides.length, 1)
    assert.equal(overrides[0]!.tradeId, 'trade-1')
    assert.deepEqual(overrides[0]!.changedSides, ['sl'])
  })

  it('coalesces multiple legs restored in one basket incident', async () => {
    const overrides = detectManualBrokerStopOverrides({
      familyTrades: [leg('trade-1', 1001), leg('trade-2', 1002, { tp: 4030 })],
      perLegTargets: [{ stoploss: 3990, takeprofit: 4020 }, { stoploss: 3990, takeprofit: 4030 }],
      ordersByTicket: new Map([
        [1001, { ticket: 1001, stopLoss: 3980, takeProfit: 4020 }],
        [1002, { ticket: 1002, stopLoss: 3990, takeProfit: 4040 }],
      ]),
      nImmCwe: 0,
    })
    assert.equal(overrides.length, 2)

    const { supabase, inserts } = makeSupabase()
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    const sent = await notifyManualBrokerOverrideReverted({
      supabase: supabase as never,
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      anchorSignalId: 'anchor-1',
      sourceSignalId: 'anchor-1',
      channelId: 'channel-1',
      symbol: 'XAUUSD',
      direction: 'buy',
      reconcileJobId: 'job-1',
      overrides,
      restoredTradeIds: ['trade-1', 'trade-2'],
    })

    assert.equal(sent, true)
    assert.equal(inserts.filter(c => c.table === 'trade_execution_logs').length, 1)
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0]!.body.user_id, 'user-1')
    assert.equal(fetchCalls[0]!.body.broker_account_id, 'broker-1')
    assert.equal(fetchCalls[0]!.body.manage_signal_path, '/manage-signals?edit=anchor-1')
  })

  it('does not warn for naked-fill missing broker stops', () => {
    const overrides = detectManualBrokerStopOverrides({
      familyTrades: [leg('trade-1', 1001)],
      perLegTargets: [{ stoploss: 3990, takeprofit: 4020 }],
      ordersByTicket: new Map([[1001, { ticket: 1001, stopLoss: 0, takeProfit: 0 }]]),
      nImmCwe: 0,
    })

    assert.equal(overrides.length, 0)
  })


  it('returns deliberate rejection reasons for classifier exits', () => {
    assert.deepEqual(detectManualBrokerStopOverridesDetailed({
      familyTrades: [],
      perLegTargets: [{ stoploss: 3990, takeprofit: 4020 }],
      ordersByTicket: new Map([[1001, { ticket: 1001, stopLoss: 3980, takeProfit: 4020 }]]),
      nImmCwe: 0,
    }).rejectedReasons.map(r => r.reason), ['empty_family_trades'])

    assert.deepEqual(detectManualBrokerStopOverridesDetailed({
      familyTrades: [leg('trade-1', 1001)],
      perLegTargets: [],
      ordersByTicket: new Map([[1001, { ticket: 1001, stopLoss: 3980, takeProfit: 4020 }]]),
      nImmCwe: 0,
    }).rejectedReasons.map(r => r.reason), ['empty_per_leg_targets'])

    assert.deepEqual(detectManualBrokerStopOverridesDetailed({
      familyTrades: [leg('trade-1', 1001)],
      perLegTargets: [{ stoploss: 3990, takeprofit: 4020 }],
      ordersByTicket: new Map(),
      nImmCwe: 0,
    }).rejectedReasons.map(r => r.reason), ['empty_broker_orders'])

    assert.deepEqual(detectManualBrokerStopOverridesDetailed({
      familyTrades: [leg('trade-1', 1001, { sl: 3980 })],
      perLegTargets: [{ stoploss: 3990, takeprofit: 4020 }],
      ordersByTicket: new Map([[1001, { ticket: 1001, stopLoss: 3980, takeProfit: 4020 }]]),
      nImmCwe: 0,
    }).rejectedReasons.map(r => r.reason), ['db_not_managed_targets'])
  })

  it('ignores frozen/CWE TP differences but still detects passive SL drift', () => {
    const frozen = detectManualBrokerStopOverridesDetailed({
      familyTrades: [leg('trade-1', 1001, { tp: 4030 })],
      perLegTargets: [{ stoploss: 3990, takeprofit: 4020 }],
      ordersByTicket: new Map([[1001, { ticket: 1001, stopLoss: 3980, takeProfit: 4040 }]]),
      nImmCwe: 0,
      tpFrozen: true,
    })
    assert.equal(frozen.overrides.length, 1)
    assert.deepEqual(frozen.overrides[0]!.changedSides, ['sl'])

    const cwe = detectManualBrokerStopOverridesDetailed({
      familyTrades: [leg('trade-1', 1001, { tp: null })],
      perLegTargets: [{ stoploss: 3990, takeprofit: 4020 }],
      ordersByTicket: new Map([[1001, { ticket: 1001, stopLoss: 3990, takeProfit: 4040 }]]),
      nImmCwe: 1,
    })
    assert.equal(cwe.overrides.length, 0)
    assert.deepEqual(cwe.rejectedReasons.map(r => r.reason), ['broker_matches_target'])
  })

  it('does not classify DB drift from a management/UI target change as broker manual override', () => {
    const overrides = detectManualBrokerStopOverrides({
      familyTrades: [leg('trade-1', 1001, { sl: 3980 })],
      perLegTargets: [{ stoploss: 3990, takeprofit: 4020 }],
      ordersByTicket: new Map([[1001, { ticket: 1001, stopLoss: 3980, takeProfit: 4020 }]]),
      nImmCwe: 0,
    })

    assert.equal(overrides.length, 0)
  })
})

describe('manual broker override notification', () => {
  const override: ManualBrokerStopOverride = {
    tradeId: 'trade-1',
    ticket: 1001,
    brokerSl: 3980,
    targetSl: 3990,
    brokerTp: 4020,
    targetTp: 4020,
    changedSides: ['sl'],
  }

  it('creates one in-app notification, sends one email, and includes Manage Signal link', async () => {
    const { supabase, inserts } = makeSupabase()
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    const sent = await notifyManualBrokerOverrideReverted({
      supabase: supabase as never,
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      anchorSignalId: 'anchor-1',
      sourceSignalId: 'anchor-1',
      channelId: 'channel-1',
      symbol: 'XAUUSD',
      direction: 'buy',
      reconcileJobId: 'job-1',
      overrides: [override],
      restoredTradeIds: ['trade-1'],
    })

    assert.equal(sent, true)
    assert.equal(inserts.length, 1)
    assert.equal(inserts[0]!.payload.action, MANUAL_BROKER_OVERRIDE_REVERTED_ACTION)
    const payload = inserts[0]!.payload.request_payload as Record<string, unknown>
    assert.equal(payload.manage_signal_url, '/manage-signals?edit=anchor-1')
    assert.equal(payload.cta_label, 'Manage Signal')
    assert.equal(fetchCalls.length, 1)
    assert.match(fetchCalls[0]!.url, /manual-broker-override-email$/)
  })

  it('does not notify when reconcile modify failed and no drifted trade was restored', async () => {
    const { supabase, inserts } = makeSupabase()
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    const sent = await notifyManualBrokerOverrideReverted({
      supabase: supabase as never,
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      anchorSignalId: 'anchor-1',
      sourceSignalId: 'anchor-1',
      channelId: 'channel-1',
      symbol: 'XAUUSD',
      direction: 'buy',
      reconcileJobId: 'job-1',
      overrides: [override],
      restoredTradeIds: [],
    })

    assert.equal(sent, false)
    assert.equal(inserts.length, 0)
    assert.equal(fetchCount, 0)
  })

  it('does not duplicate a retry of the same reconciliation incident', async () => {
    const { supabase, inserts } = makeSupabase([
      { request_payload: { anchor_signal_id: 'anchor-1', symbol: 'XAUUSD' } },
    ])
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    const sent = await notifyManualBrokerOverrideReverted({
      supabase: supabase as never,
      userId: 'user-1',
      brokerAccountId: 'broker-1',
      anchorSignalId: 'anchor-1',
      sourceSignalId: 'anchor-1',
      channelId: 'channel-1',
      symbol: 'XAUUSD',
      direction: 'buy',
      reconcileJobId: 'job-1',
      overrides: [override],
      restoredTradeIds: ['trade-1'],
    })

    assert.equal(sent, false)
    assert.equal(inserts.length, 0)
    assert.equal(fetchCount, 0)
  })

  it('recognizes drift-sweep jobs and excludes Telegram/Manage Signal reconcile jobs', () => {
    const drift = {
      source_signal_id: 'anchor-1',
      anchor_signal_id: 'anchor-1',
      last_error: 'Drift sweep: open legs out of sync with channel SL/TP ladder',
      virtual_pendings_snapshot: null,
    } as BasketReconcileJobRow
    const telegramMgmt = {
      source_signal_id: 'mgmt-1',
      anchor_signal_id: 'anchor-1',
      last_error: 'channel_stop_apply partial 1/2',
      virtual_pendings_snapshot: null,
    } as BasketReconcileJobRow
    const tradesUi = {
      source_signal_id: 'anchor-1',
      anchor_signal_id: 'anchor-1',
      last_error: 'user_signal_override partial: 1 leg(s) failed',
      virtual_pendings_snapshot: null,
    } as BasketReconcileJobRow

    const retriedDrift = {
      source_signal_id: 'anchor-1',
      anchor_signal_id: 'anchor-1',
      last_error: 'Reconcile: 1/1 legs',
      virtual_pendings_snapshot: passiveDriftSweepSnapshot(),
    } as BasketReconcileJobRow

    assert.equal(isDriftSweepReconcileJob(drift), true)
    assert.equal(isDriftSweepReconcileJob(retriedDrift), true)
    assert.equal(isDriftSweepReconcileJob(telegramMgmt), false)
    assert.equal(isDriftSweepReconcileJob(tradesUi), false)
  })

  it('builds the Manage Signal deep-link for the anchor signal', () => {
    assert.equal(manageSignalPath('anchor 1'), '/manage-signals?edit=anchor%201')
    assert.equal(manageSignalPath(null), '/manage-signals')
  })
})
