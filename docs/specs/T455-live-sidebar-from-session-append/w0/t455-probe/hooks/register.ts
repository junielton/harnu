import type { EngineInterface, Register } from 'claude-code'

// W0 probe: the 03-prototype.md §P.4 probe plus origin, tool_use names, a prompt-text
// fingerprint (length + hash, never the text), a monotonic sequence number and the mod clock.
// Round 2: the lifecycle hooks log an `enter` entry BEFORE `next(e)`, so the order of the
// entries is the order in which the handlers started (A-E2).
const log: unknown[] = []
let out = ''
let seq = 0

async function write($: EngineInterface): Promise<void> {
  if (out === '') {
    const dir = await $.env.get('T455_PROBE_DIR')
    if (typeof dir !== 'string') return
    out = `${dir}/probe-${await $.clock.now()}.json`
  }
  await $.fs.write(out, JSON.stringify(log, null, 1))
}

function fp(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return `${s.length}:${h.toString(16)}`
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((b) =>
      b && typeof b === 'object' && (b as { type?: string }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : ''
    )
    .join('\n')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    log.push({ seq: seq++, ev: 'session.start:enter', at: await $.clock.now() })
    const r = await next(e)
    const msgs = await $.session.messages({ as: 'api' })
    log.push({
      seq: seq++,
      ev: 'session.start',
      sid: await $.session.id(),
      isInteractive: e.isInteractive,
      loadedMessages: msgs.length
    })
    await write($)
    return r
  })
  on('classic.SessionStart', async ($, e, next) => {
    log.push({
      seq: seq++,
      ev: 'classic.SessionStart',
      at: await $.clock.now(),
      session_id: e.session_id,
      source: e.source,
      transcript_path: e.transcript_path,
      session_title: e.session_title ?? null,
      sidNow: await $.session.id()
    })
    await write($)
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    log.push({
      seq: seq++,
      ev: 'classic.UserPromptSubmit',
      at: await $.clock.now(),
      session_id: e.session_id,
      session_title: e.session_title ?? null,
      source: e.source ?? null
    })
    await write($)
    return next(e)
  })
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    const content = r.deny === undefined ? r.message.content : []
    const blocks = Array.isArray(content) ? content.map((b) => b.type) : []
    const toolUses = Array.isArray(content)
      ? content
          .filter((b) => b.type === 'tool_use')
          .map((b) => (b as { name?: string }).name ?? '?')
      : []
    log.push({
      seq: seq++,
      ev: 'session.append',
      door: e.door,
      origin: e.origin,
      type: r.deny === undefined ? r.message.type : null,
      role: r.deny === undefined ? r.message.role : null,
      isMeta: r.deny === undefined ? r.message.isMeta : null,
      name: r.deny === undefined ? r.message.name : null,
      uuid: r.deny === undefined ? r.uuid : null,
      blocks,
      toolUses,
      text: e.door === 'prompt' ? fp(textOf(content)) : null,
      agentId: e.agentId ?? null,
      sidNow: await $.session.id(),
      at: await $.clock.now()
    })
    await write($)
    return r
  })
  on('turn.complete', async ($, e, next) => {
    log.push({
      seq: seq++,
      ev: 'turn.complete',
      at: await $.clock.now(),
      reason: e.reason,
      agentId: e.agentId ?? null,
      sidNow: await $.session.id()
    })
    await write($)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    log.push({ seq: seq++, ev: 'session.end', reason: e.reason, sessionId: e.sessionId })
    await write($)
    return next(e)
  })
}
