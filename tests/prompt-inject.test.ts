import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pasteAndSubmit } from '../src/renderer/src/components/prompt-inject'

/**
 * `pasteAndSubmit` (T40/T62/BUG-9) writes the two byte sequences that make up an
 * actual injection: the bracketed paste, then the submitting `\r` once the paste
 * echo settles. T172 adds an optional `record` observer at both write points —
 * these are the last two decision points of the pre-prompt injection trail (see
 * `docs/adr/0007-injection-trail-is-an-in-memory-renderer-ledger.md`). Runs in
 * the default `node` vitest environment; `window.api` is stubbed with spies,
 * mirroring `tests/settings-store.test.ts`.
 */

type PtyDataCb = (data: string, seq: number) => void
type PtyExitCb = () => void

function makeApi(): {
  ptyWrite: ReturnType<typeof vi.fn>
  onPtyData: ReturnType<typeof vi.fn>
  onPtyExit: ReturnType<typeof vi.fn>
  emitData: (id: string) => void
  emitExit: (id: string) => void
} {
  const dataCbs = new Map<string, PtyDataCb>()
  const exitCbs = new Map<string, PtyExitCb>()
  return {
    ptyWrite: vi.fn(),
    onPtyData: vi.fn((id: string, cb: PtyDataCb) => {
      dataCbs.set(id, cb)
      return () => dataCbs.delete(id)
    }),
    onPtyExit: vi.fn((id: string, cb: PtyExitCb) => {
      exitCbs.set(id, cb)
      return () => exitCbs.delete(id)
    }),
    emitData: (id: string) => dataCbs.get(id)?.('x', 1),
    emitExit: (id: string) => exitCbs.get(id)?.()
  }
}

describe('pasteAndSubmit (injection trail write points — T172)', () => {
  let api: ReturnType<typeof makeApi>

  beforeEach(() => {
    api = makeApi()
    vi.stubGlobal('window', { api })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('records paste-written immediately after the bracketed paste is written', () => {
    const record = vi.fn()
    pasteAndSubmit('pty-1', 'hello', record)
    expect(api.ptyWrite).toHaveBeenCalledWith('pty-1', expect.stringContaining('hello'))
    expect(record).toHaveBeenCalledWith({ type: 'paste-written' })
  })

  it('records submit-written after the settling \\r actually lands (quiescence)', () => {
    vi.useFakeTimers()
    const record = vi.fn()
    pasteAndSubmit('pty-1', 'hello', record)
    record.mockClear()
    api.emitData('pty-1')
    vi.advanceTimersByTime(300) // PROMPT_SUBMIT_QUIET_MS
    expect(api.ptyWrite).toHaveBeenCalledWith('pty-1', '\r')
    expect(record).toHaveBeenCalledWith({ type: 'submit-written' })
  })

  it('never records submit-written if the PTY exits before quiescence', () => {
    vi.useFakeTimers()
    const record = vi.fn()
    pasteAndSubmit('pty-1', 'hello', record)
    record.mockClear()
    api.emitExit('pty-1')
    vi.advanceTimersByTime(5000)
    expect(record).not.toHaveBeenCalledWith({ type: 'submit-written' })
    expect(api.ptyWrite).not.toHaveBeenCalledWith('pty-1', '\r')
  })

  it('never records paste-written when the initial write throws (PTY gone)', () => {
    api.ptyWrite.mockImplementationOnce(() => {
      throw new Error('pty gone')
    })
    const record = vi.fn()
    pasteAndSubmit('pty-1', 'hello', record)
    expect(record).not.toHaveBeenCalled()
  })

  it('record is optional — omitting it is a no-op, not a throw', () => {
    expect(() => pasteAndSubmit('pty-1', 'hello')).not.toThrow()
  })
})
