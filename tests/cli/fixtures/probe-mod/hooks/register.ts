import type { Register } from 'claude-code'

// Test-only. /harnu-probe answers from `command.run`, so a `claude -p "/harnu-probe"` run makes
// no model request (smoke C4). It prints, as JSON, what it observed.
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
