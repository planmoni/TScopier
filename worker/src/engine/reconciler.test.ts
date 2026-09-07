import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyReconcileActions, computeReconcileActions } from './reconciler'
import type { FxOpenOrder, FxOrderResult } from './fxContract'

function open(ticket: number, over: Partial<FxOpenOrder> = {}): FxOpenOrder {
  return { ticket, symbol: 'XAUUSD', operation: 'Buy', isBuy: true, volume: 0.05, openPrice: 4078, stopLoss: null, takeProfit: null, comment: '', magic: 770077, isPending: false, ...over }
}

describe('computeReconcileActions (pure diff)', () => {
  it('emits NOTHING when broker already matches desired (idempotent no-op)', () => {
    const a = computeReconcileActions({
      desired: [{ ticket: 1, stoploss: 4090, takeProfit: 4083 }],
      openOrders: [open(1, { stopLoss: 4090, takeProfit: 4083 })],
      trackedTickets: [1],
    })
    assert.equal(a.modifies.length, 0)
    assert.equal(a.closedTickets.length, 0)
    assert.equal(a.adopt.length, 0)
  })

  it('modifies only the drifted side', () => {
    const a = computeReconcileActions({
      desired: [{ ticket: 1, stoploss: 4090, takeProfit: 4083 }],
      openOrders: [open(1, { stopLoss: 4065, takeProfit: 4083 })], // SL drifted, TP matches
      trackedTickets: [1],
    })
    assert.equal(a.modifies.length, 1)
    assert.equal(a.modifies[0]!.stoploss, 4090)
    assert.equal(a.modifies[0]!.takeProfit, null, 'TP already correct -> not repainted')
  })

  it('does not repaint TP when allowTpModify is false (TP-hit freeze), still syncs SL', () => {
    const a = computeReconcileActions({
      desired: [{ ticket: 1, stoploss: 4090, takeProfit: 4083 }],
      openOrders: [open(1, { stopLoss: 4065, takeProfit: 9999 })],
      trackedTickets: [1],
      allowTpModify: false,
    })
    assert.equal(a.modifies.length, 1)
    assert.equal(a.modifies[0]!.stoploss, 4090)
    assert.equal(a.modifies[0]!.takeProfit, null)
  })

  it('flags tracked-but-gone tickets as closed', () => {
    const a = computeReconcileActions({
      desired: [{ ticket: 1, stoploss: 4090, takeProfit: null }],
      openOrders: [],
      trackedTickets: [1, 2],
    })
    assert.deepEqual(a.closedTickets.sort(), [1, 2])
  })

  it('adopts broker orphans carrying our magic but not tracked', () => {
    const a = computeReconcileActions({
      desired: [],
      openOrders: [open(50, { magic: 770077 }), open(51, { magic: 12345 })],
      trackedTickets: [],
    })
    assert.equal(a.adopt.length, 1)
    assert.equal(a.adopt[0]!.ticket, 50)
  })
})

describe('applyReconcileActions', () => {
  it('SL-first fallback: combined modify rejected on invalid stops -> applies SL alone', async () => {
    const calls: Array<Record<string, unknown>> = []
    const fx = {
      async orderModify(_a: string, _p: string, req: any): Promise<FxOrderResult> {
        calls.push(req)
        const invalid: FxOrderResult = { ok: false, partial: false, retcode: 10016, retcodeName: 'INVALID_STOPS', message: 'Invalid stops', ticket: null, order: null, deal: null, volume: null, price: null, bid: null, ask: null, comment: null, raw: null }
        const ok: FxOrderResult = { ok: true, partial: false, retcode: 10009, retcodeName: 'DONE', message: 'Done', ticket: 1, order: 1, deal: 1, volume: null, price: null, bid: null, ask: null, comment: null, raw: null }
        return req.takeProfit != null ? invalid : ok
      },
    }
    const res = await applyReconcileActions(
      { fx: fx as never, accountId: 'a', platform: 'MT5', markClosed: async () => {}, adoptOrphan: async () => {} },
      { modifies: [{ ticket: 1, stoploss: 4090, takeProfit: 4083 }], adopt: [], closedTickets: [] },
    )
    assert.equal(res.modified, 1)
    assert.deepEqual(res.modifiedTickets, [1])
    assert.equal(calls.length, 2, 'combined then SL-only')
    assert.equal(calls[1]!.takeProfit, undefined)
  })

  it('calls markClosed and adoptOrphan for the respective actions', async () => {
    const closed: number[] = []
    const adopted: number[] = []
    const fx = { async orderModify(): Promise<FxOrderResult> { return { ok: true, partial: false, retcode: 10009, retcodeName: 'DONE', message: 'Done', ticket: 1, order: 1, deal: 1, volume: null, price: null, bid: null, ask: null, comment: null, raw: null } } }
    const res = await applyReconcileActions(
      { fx: fx as never, accountId: 'a', platform: 'MT5', markClosed: async t => { closed.push(t) }, adoptOrphan: async o => { adopted.push(o.ticket) } },
      { modifies: [], adopt: [open(77)], closedTickets: [9] },
    )
    assert.deepEqual(closed, [9])
    assert.deepEqual(adopted, [77])
    assert.deepEqual(res.modifiedTickets, [])
    assert.equal(res.closed, 1)
    assert.equal(res.adopted, 1)
  })
})
