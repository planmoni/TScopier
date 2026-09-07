import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { V2ReconcileMonitor, buildDesiredLegTargets, closestLadderTp } from './v2ReconcileMonitor'
import type { FxOpenOrder } from './fxContract'
import type { BasketOpenLeg } from '../basketSlTpReconcile'

function leg(over: Partial<BasketOpenLeg> = {}): BasketOpenLeg {
  return { id: 'leg', signal_id: 'sig', metaapi_order_id: '100', opened_at: '', lot_size: 0.05, sl: 4065, tp: 4089, entry_price: 4078, direction: 'buy', symbol: 'XAUUSD', auto_be_applied_at: null, ...over }
}
function open(ticket: number, over: Partial<FxOpenOrder> = {}): FxOpenOrder {
  return { ticket, symbol: 'XAUUSD', operation: 'Buy', isBuy: true, volume: 0.05, openPrice: 4078, stopLoss: 4065, takeProfit: 4089, comment: '', magic: 770077, isPending: false, ...over }
}

describe('buildDesiredLegTargets', () => {
  it('applies the effective basket SL to every leg present at the broker', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100' }), leg({ id: 'l2', metaapi_order_id: '101' })],
      snapshot: [open(100), open(101)],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4089],
      isBuy: true,
    })
    assert.equal(t.length, 2)
    assert.ok(t.every(x => x.stoploss === 4090))
  })

  it('keeps the existing broker TP (never repaints a present TP)', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100' })],
      snapshot: [open(100, { takeProfit: 4089 })],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4095],
      isBuy: true,
    })
    assert.equal(t[0]!.takeProfit, 4089, 'present TP preserved, not replaced by ladder')
  })

  it('fills a leg naked everywhere (no DB TP, no broker TP) with the deepest ladder TP', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', tp: null })],
      snapshot: [open(100, { takeProfit: null })],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4095],
      isBuy: true,
    })
    assert.equal(t[0]!.takeProfit, 4095, 'deepest (farthest) TP for a buy')
  })

  it('prefers the intended DB TP over a drifted broker TP (self-heals a collapsed distribution)', () => {
    // The basket distributed TP1=4083 to this leg, but a racing tick previously
    // pushed the deepest TP (4095) onto the broker. The reconciler must restore
    // the intended distributed TP, not keep the broker's collapsed deepest.
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', tp: 4083 })],
      snapshot: [open(100, { takeProfit: 4095 })],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4089, 4095],
      isBuy: true,
    })
    assert.equal(t[0]!.takeProfit, 4083, 'intended DB TP wins over drifted broker TP')
  })

  it('uses the intended DB TP for a leg still naked on the broker (race with in-flight distribution)', () => {
    // mgmt modify wrote the distributed TP to the DB but the broker snapshot was
    // captured before the broker modify landed. Without this the tick would fill
    // the deepest TP and collapse the distribution.
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', tp: 4089 })],
      snapshot: [open(100, { takeProfit: null })],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4089, 4095],
      isBuy: true,
    })
    assert.equal(t[0]!.takeProfit, 4089, 'naked broker leg gets the intended DB TP, not the deepest')
  })

  it('enforces SL on a naked leg (broker SL missing) using the effective SL', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', sl: 0 })],
      snapshot: [open(100, { stopLoss: null })],
      effectiveSl: 3970,
      effectiveTpLevels: [4005, 4010, 4015],
      isBuy: true,
    })
    assert.equal(t[0]!.stoploss, 3970, 'naked broker leg gets the effective SL')
  })

  it('preserves a more-protective per-leg auto-breakeven (never loosens a BE leg)', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', sl: 4078, auto_be_applied_at: '2026-06-24T11:00:00Z' })],
      snapshot: [open(100, { stopLoss: 4078 })],
      effectiveSl: 4065, // looser than the BE 4078 for a buy
      effectiveTpLevels: [4089],
      isBuy: true,
    })
    assert.equal(t[0]!.stoploss, 4078, 'BE SL kept; not loosened to 4065')
  })

  it('keeps each leg its own breakeven SL — never collapses a multi-entry basket onto one SL', () => {
    // Two layered entries breakevened at different entry-relative SLs. The basket-level
    // effectiveSl equals the deepest leg BE (4078); it must NOT be forced onto leg 2.
    const t = buildDesiredLegTargets({
      legs: [
        leg({ id: 'l1', metaapi_order_id: '100', sl: 4078, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
        leg({ id: 'l2', metaapi_order_id: '101', sl: 4072, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
      ],
      snapshot: [open(100, { stopLoss: 4078 }), open(101, { stopLoss: 4072 })],
      effectiveSl: 4078,
      effectiveTpLevels: [4089],
      isBuy: true,
      effectiveSource: 'channel_memory',
    })
    const byTicket = new Map(t.map(x => [x.ticket, x.stoploss]))
    assert.equal(byTicket.get(100), 4078, 'leg 1 keeps its own breakeven')
    assert.equal(byTicket.get(101), 4072, 'leg 2 keeps its own breakeven, not collapsed to 4078')
  })

  it('restores per-leg BE from entry+offset when trades.sl was collapsed to one price', () => {
    const t = buildDesiredLegTargets({
      legs: [
        leg({
          id: 'l1',
          metaapi_order_id: '100',
          entry_price: 4504,
          sl: 4504.10,
          auto_be_applied_at: '2026-08-19T00:00:00Z',
          auto_be_offset_pips: 1,
        }),
        leg({
          id: 'l2',
          metaapi_order_id: '101',
          entry_price: 4500,
          sl: 4504.10,
          auto_be_applied_at: '2026-08-19T00:00:00Z',
          auto_be_offset_pips: 1,
        }),
      ],
      snapshot: [open(100, { openPrice: 4504, stopLoss: 4504.10 }), open(101, { openPrice: 4500, stopLoss: 4504.10 })],
      effectiveSl: 4504.10,
      effectiveTpLevels: [4530],
      isBuy: true,
      effectiveSource: 'channel_memory',
    })
    const byTicket = new Map(t.map(x => [x.ticket, x.stoploss]))
    assert.equal(byTicket.get(100), 4504.1)
    assert.equal(byTicket.get(101), 4500.1, 'collapsed 4504.10 restored to this fill + 1 pip')
  })

  it('does not paint most-protective BE onto an unstamped sibling', () => {
    const t = buildDesiredLegTargets({
      legs: [
        leg({
          id: 'l1',
          metaapi_order_id: '100',
          entry_price: 4504,
          sl: 4504.10,
          auto_be_applied_at: '2026-08-19T00:00:00Z',
          auto_be_offset_pips: 1,
        }),
        leg({
          id: 'l2',
          metaapi_order_id: '101',
          entry_price: 4500,
          sl: 4300,
          auto_be_applied_at: null,
        }),
      ],
      snapshot: [open(100, { openPrice: 4504, stopLoss: 4504.10 }), open(101, { openPrice: 4500, stopLoss: 4300 })],
      effectiveSl: 4504.10,
      effectiveTpLevels: [4530],
      isBuy: true,
      effectiveSource: 'anchor',
    })
    const byTicket = new Map(t.map(x => [x.ticket, x.stoploss]))
    assert.equal(byTicket.get(100), 4504.1)
    assert.notEqual(byTicket.get(101), 4504.1, 'unstamped sibling must not inherit 4504.10')
  })

  it('lets an explicit newer instruction (basket_target) override per-leg breakeven on all legs', () => {
    const t = buildDesiredLegTargets({
      legs: [
        leg({ id: 'l1', metaapi_order_id: '100', sl: 4078, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
        leg({ id: 'l2', metaapi_order_id: '101', sl: 4072, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
      ],
      snapshot: [open(100, { stopLoss: 4078 }), open(101, { stopLoss: 4072 })],
      effectiveSl: 4090,
      effectiveTpLevels: [4089],
      isBuy: true,
      effectiveSource: 'basket_target',
    })
    assert.ok(t.every(x => x.stoploss === 4090), 'explicit Adjust applies to every leg (latest instruction wins)')
  })

  it('lets a Manage Signals override (user_override) replace per-leg breakeven on all legs', () => {
    const t = buildDesiredLegTargets({
      legs: [
        leg({ id: 'l1', metaapi_order_id: '100', sl: 4078, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
        leg({ id: 'l2', metaapi_order_id: '101', sl: 4072, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
      ],
      snapshot: [open(100, { stopLoss: 4078 }), open(101, { stopLoss: 4072 })],
      effectiveSl: 4090,
      effectiveTpLevels: [4089],
      isBuy: true,
      effectiveSource: 'user_override',
    })
    assert.ok(t.every(x => x.stoploss === 4090), 'Manage Signals SL applies to every leg')
  })

  it('skips legs not present at the broker (left for closedTickets)', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100' }), leg({ id: 'l2', metaapi_order_id: '999' })],
      snapshot: [open(100)],
      effectiveSl: 4090,
      effectiveTpLevels: [],
      isBuy: true,
    })
    assert.equal(t.length, 1)
    assert.equal(t[0]!.ticket, 100)
  })

  it('adjust-source basket target remaps stale leg TP to nearest revised ladder level', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', tp: 4070 })],
      snapshot: [open(100, { takeProfit: 4070 })],
      effectiveSl: 4038,
      effectiveTpLevels: [4063, 4067, 4072],
      isBuy: true,
      effectiveSource: 'basket_target',
      basketTargetSource: 'adjust',
    })
    assert.equal(t[0]!.takeProfit, 4072)
    assert.equal(closestLadderTp(4070, [4063, 4067, 4072]), 4072)
  })

  it('keeps in-ladder DB TP under adjust-source basket target', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', tp: 4063 })],
      snapshot: [open(100, { takeProfit: 4063 })],
      effectiveSl: 4038,
      effectiveTpLevels: [4063, 4067, 4072],
      isBuy: true,
      effectiveSource: 'basket_target',
      basketTargetSource: 'adjust',
    })
    assert.equal(t[0]!.takeProfit, 4063)
  })
})

type InsertRow = { table: string; payload: Record<string, unknown> }

function makeV2Supabase(opts: {
  legs: BasketOpenLeg[]
  targetSl?: number | null
  targetTps?: number[] | null
  existingNotifications?: Array<{ request_payload?: Record<string, unknown> | null; created_at?: string | null }>
}) {
  const inserts: InsertRow[] = []
  const anchor = {
    parsed_data: { sl: opts.targetSl ?? null, tp: opts.targetTps ?? [] },
    channel_id: null,
    user_id: 'user-1',
    created_at: '2026-09-07T10:00:00.000Z',
    user_override: null,
  }
  const target = opts.targetSl != null || opts.targetTps != null
    ? {
        stoploss: opts.targetSl ?? null,
        tp_levels: opts.targetTps ?? [],
        source: 'entry',
        updated_at: '2026-09-07T10:00:00.000Z',
        instruction_at: '2026-09-07T10:00:00.000Z',
      }
    : null

  function builder(table: string) {
    let selected = ''
    const b: Record<string, unknown> = {}
    b.select = (value: string) => { selected = value; return b }
    b.eq = () => b
    b.gte = () => b
    b.order = () => b
    b.limit = () => {
      if (table === 'trades') return Promise.resolve({ data: opts.legs, error: null })
      if (table === 'trade_execution_logs') return Promise.resolve({ data: opts.existingNotifications ?? [], error: null })
      return Promise.resolve({ data: [], error: null })
    }
    b.maybeSingle = () => {
      if (table === 'signals' && selected.includes('user_override')) return Promise.resolve({ data: { user_override: null }, error: null })
      if (table === 'signals') return Promise.resolve({ data: anchor, error: null })
      if (table === 'basket_sl_tp_targets') return Promise.resolve({ data: target, error: null })
      return Promise.resolve({ data: null, error: null })
    }
    b.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload })
      return Promise.resolve({ data: null, error: null })
    }
    return b
  }

  return { supabase: { from: (table: string) => builder(table) }, inserts }
}

function okModifyResult(ticket: number) {
  return { ok: true, partial: false, retcode: 10009, retcodeName: 'DONE', message: 'Done', ticket, order: ticket, deal: ticket, volume: null, price: null, bid: null, ask: null, comment: null, raw: null }
}

function failModifyResult(ticket: number) {
  return { ok: false, partial: false, retcode: 10030, retcodeName: 'REJECT', message: 'Rejected', ticket, order: null, deal: null, volume: null, price: null, bid: null, ask: null, comment: null, raw: null }
}

async function runV2Reconcile(opts: {
  legs: BasketOpenLeg[]
  snapshot: FxOpenOrder[]
  targetSl?: number | null
  targetTps?: number[] | null
  modifyOk?: boolean
  existingNotifications?: Array<{ request_payload?: Record<string, unknown> | null; created_at?: string | null }>
}) {
  const { supabase, inserts } = makeV2Supabase(opts)
  const modifyCalls: Array<Record<string, unknown>> = []
  const fx = {
    async openedOrders() { return opts.snapshot },
    async orderModify(_accountId: string, _platform: string, req: Record<string, unknown>) {
      modifyCalls.push(req)
      const ticket = Number(req.ticket)
      return opts.modifyOk === false ? failModifyResult(ticket) : okModifyResult(ticket)
    },
  }
  const oldUrl = process.env.SUPABASE_URL
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const fetchCalls: Array<{ url: string; body: unknown }> = []
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch
  try {
    const monitor = new V2ReconcileMonitor(supabase as never, fx as never)
    const result = await (monitor as unknown as {
      reconcileBasket: (basket: { brokerAccountId: string; anchorSignalId: string; symbol: string; isBuy: boolean }, session: { uuid: string; platform: 'MT5'; userId: string }) => Promise<{ modified: number; closed: number }>
    }).reconcileBasket(
      { brokerAccountId: 'broker-1', anchorSignalId: 'signal-1', symbol: 'XAUUSD', isBuy: true },
      { uuid: 'acct-1', platform: 'MT5', userId: 'user-1' },
    )
    return { result, inserts, modifyCalls, fetchCalls }
  } finally {
    if (oldUrl === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = oldUrl
    if (oldKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey
  }
}

function manualOverrideEvents(inserts: InsertRow[]) {
  return inserts.filter(row => row.table === 'trade_execution_logs' && row.payload.action === 'broker_manual_stop_override_reverted')
}

describe('V2ReconcileMonitor manual broker override notifications', () => {
  it('detects a manual SL override and emits after successful restore', async () => {
    const out = await runV2Reconcile({
      legs: [leg({ id: 'trade-1', metaapi_order_id: '100', sl: 4065, tp: 4089 })],
      snapshot: [open(100, { stopLoss: 4050, takeProfit: 4089 })],
      targetSl: 4065,
      targetTps: [4089],
    })

    assert.equal(out.result.modified, 1)
    assert.equal(manualOverrideEvents(out.inserts).length, 1)
    const payload = manualOverrideEvents(out.inserts)[0]!.payload.request_payload as Record<string, unknown>
    assert.deepEqual(payload.changed_sides, ['sl'])
    assert.deepEqual(payload.restored_trade_ids, ['trade-1'])
    assert.equal(out.fetchCalls.length, 1)
  })

  it('detects a manual TP override and emits after successful restore', async () => {
    const out = await runV2Reconcile({
      legs: [leg({ id: 'trade-1', metaapi_order_id: '100', sl: 4065, tp: 4089 })],
      snapshot: [open(100, { stopLoss: 4065, takeProfit: 4099 })],
      targetSl: 4065,
      targetTps: [4089],
    })

    assert.equal(out.result.modified, 1)
    assert.equal(manualOverrideEvents(out.inserts).length, 1)
    const payload = manualOverrideEvents(out.inserts)[0]!.payload.request_payload as Record<string, unknown>
    assert.deepEqual(payload.changed_sides, ['tp'])
  })

  it('coalesces simultaneous SL and TP overrides into one event', async () => {
    const out = await runV2Reconcile({
      legs: [leg({ id: 'trade-1', metaapi_order_id: '100', sl: 4065, tp: 4089 })],
      snapshot: [open(100, { stopLoss: 4050, takeProfit: 4099 })],
      targetSl: 4065,
      targetTps: [4089],
    })

    assert.equal(manualOverrideEvents(out.inserts).length, 1)
    const payload = manualOverrideEvents(out.inserts)[0]!.payload.request_payload as Record<string, unknown>
    assert.deepEqual(payload.changed_sides, ['sl', 'tp'])
  })

  it('coalesces multiple restored legs into one logical incident', async () => {
    const out = await runV2Reconcile({
      legs: [
        leg({ id: 'trade-1', metaapi_order_id: '100', sl: 4065, tp: 4089 }),
        leg({ id: 'trade-2', metaapi_order_id: '101', sl: 4065, tp: 4095 }),
      ],
      snapshot: [
        open(100, { stopLoss: 4050, takeProfit: 4089 }),
        open(101, { stopLoss: 4055, takeProfit: 4095 }),
      ],
      targetSl: 4065,
      targetTps: [4089, 4095],
    })

    assert.equal(out.result.modified, 2)
    assert.equal(manualOverrideEvents(out.inserts).length, 1)
    const payload = manualOverrideEvents(out.inserts)[0]!.payload.request_payload as Record<string, unknown>
    assert.deepEqual(payload.restored_trade_ids, ['trade-1', 'trade-2'])
    assert.equal(out.fetchCalls.length, 1)
  })

  it('does not emit for zero/missing broker protection recovery', async () => {
    const out = await runV2Reconcile({
      legs: [leg({ id: 'trade-1', metaapi_order_id: '100', sl: 4065, tp: 4089 })],
      snapshot: [open(100, { stopLoss: null, takeProfit: null })],
      targetSl: 4065,
      targetTps: [4089],
    })

    assert.equal(out.result.modified, 1)
    assert.equal(manualOverrideEvents(out.inserts).length, 0)
    assert.equal(out.fetchCalls.length, 0)
  })

  it('does not emit for a TScopier target change while DB is not yet at the desired target', async () => {
    const out = await runV2Reconcile({
      legs: [leg({ id: 'trade-1', metaapi_order_id: '100', sl: 4065, tp: 4089 })],
      snapshot: [open(100, { stopLoss: 4065, takeProfit: 4089 })],
      targetSl: 4050,
      targetTps: [4089],
    })

    assert.equal(out.result.modified, 1)
    assert.equal(manualOverrideEvents(out.inserts).length, 0)
    assert.equal(out.fetchCalls.length, 0)
  })
  it('does not emit when OrderModify fails', async () => {
    const out = await runV2Reconcile({
      legs: [leg({ id: 'trade-1', metaapi_order_id: '100', sl: 4065, tp: 4089 })],
      snapshot: [open(100, { stopLoss: 4050, takeProfit: 4089 })],
      targetSl: 4065,
      targetTps: [4089],
      modifyOk: false,
    })

    assert.equal(out.result.modified, 0)
    assert.equal(manualOverrideEvents(out.inserts).length, 0)
    assert.equal(out.fetchCalls.length, 0)
  })

  it('does not emit for no-op reconcile ticks', async () => {
    const out = await runV2Reconcile({
      legs: [leg({ id: 'trade-1', metaapi_order_id: '100', sl: 4065, tp: 4089 })],
      snapshot: [open(100, { stopLoss: 4065, takeProfit: 4089 })],
      targetSl: 4065,
      targetTps: [4089],
    })

    assert.equal(out.result.modified, 0)
    assert.equal(out.modifyCalls.length, 0)
    assert.equal(manualOverrideEvents(out.inserts).length, 0)
    assert.equal(out.fetchCalls.length, 0)
  })
})