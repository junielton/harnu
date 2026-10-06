import type { EngineInterface, Register } from 'claude-code'

// Test-only. /harnu-probe answers from `command.run`, so a `claude -p "/harnu-probe"` run makes
// no model request (smoke C4). It prints, as JSON, what it observed.
//
// P1W3 additions, for the handshake suite: when HARNU_PROBE_OUT names a file the probe writes
// what it saw there (hook payload shapes and the `session.end` budget). It never reads or prints
// a token; it only records field NAMES of the classic payload and a few ids.

const classic: { source: string; sessionId: string; keys: string[] }[] = []
let endBudgetMs: number | null = null

async function saveNotes($: EngineInterface): Promise<void> {
  const out = await $.env.get('HARNU_PROBE_OUT')
  if (typeof out !== 'string' || out === '') return
  await $.fs.write(out, JSON.stringify({ classic, endBudgetMs }))
}

export const register: Register = (on) => {
  const seen: string[] = []

  // Sees every hooks module admitted AFTER this one: the load-order probe (AC-P1W2-17).
  on('plugin.register', async (_$, e, next) => {
    seen.push(e.name)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'harnu-probe', description: 'Report what the probe observed' })
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    classic.push({ source: e.source, sessionId: e.session_id, keys: Object.keys(e).sort() })
    try {
      await saveNotes($)
    } catch {
      // best effort: the probe must never break the run
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    endBudgetMs = next.budget.remainingMs
    try {
      await saveNotes($)
    } catch {
      // best effort: the probe must never break the run
    }
    return next(e)
  })

  on('command.run', { command: 'harnu-probe' }, async ($) => {
    const token = await $.env.get('HARNU_SPAWN_TOKEN')
    return {
      text: JSON.stringify({
        sessionId: await $.session.id(),
        pluginsRegisteredAfterProbe: seen,
        // Presence only: the token itself is never printed or logged.
        tokenReadable: typeof token === 'string' && token.length > 0
      })
    }
  })
}
