import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withTelegramTimeout } from './userListener'

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withTelegramTimeout', () => {
  it('resolves with the underlying promise result when it settles first', async () => {
    const result = await withTelegramTimeout(Promise.resolve('ok'), 500, 'test')
    assert.equal(result, 'ok')
  })

  it('rejects with a timeout error when the promise never settles', async () => {
    const d = deferred()
    const raced = withTelegramTimeout(d.promise, 20, 'hang')
    await assert.rejects(raced, /hang timed out after 20ms/)
    // Settle the underlying promise so the test's async tracking is not left pending.
    d.resolve()
  })

  it('rejects with the underlying error when it fails before the timeout', async () => {
    await assert.rejects(
      withTelegramTimeout(Promise.reject(new Error('boom')), 500, 'test'),
      /boom/,
    )
  })
})