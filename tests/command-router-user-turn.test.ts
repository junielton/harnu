import { describe, expect, it } from 'vitest'
import {
  makeCommandRouter,
  type CommandRouterActions
} from '../src/renderer/src/stores/command-router'

const turn = { sessionId: 's1', folder: '/w/f', text: 'hello', source: 'overlay' }

function router(deliver: NonNullable<CommandRouterActions['deliverUserTurn']>) {
  return makeCommandRouter({ deliverUserTurn: deliver } as unknown as CommandRouterActions)
}

describe('session.userTurn', () => {
  it('answers synchronously when the delivery does', () => {
    const r = router(() => ({ delivered: true, sessionId: 's1' }))
    expect(r('session.userTurn', turn)).toEqual({ delivered: true, sessionId: 's1' })
  })

  it('answers with a promise when the paste waits for the operator to stop typing', async () => {
    const r = router(
      () => new Promise((res) => setTimeout(() => res({ delivered: true, sessionId: 's1' }), 5))
    )
    const out = r('session.userTurn', turn)
    expect(out).toBeInstanceOf(Promise)
    expect(await out).toEqual({ delivered: true, sessionId: 's1' })
  })

  it('turns a rejected delivery into an error ack instead of an unhandled rejection', async () => {
    const r = router(() => Promise.reject(new Error('pty exploded')))
    expect(await r('session.userTurn', turn)).toEqual({ ok: false, error: 'pty exploded' })
  })

  it('forwards the overlay source and refuses a malformed payload', () => {
    let seen: unknown = null
    const r = router((t) => {
      seen = t
      return { held: true }
    })
    r('session.userTurn', turn)
    expect(seen).toEqual(turn)
    expect(r('session.userTurn', { folder: '', text: '' })).toEqual({ error: 'BAD_ARGS' })
  })
})
