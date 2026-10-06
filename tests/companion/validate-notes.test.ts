import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareToManifest, parseValidateNotes } from '../../scripts/ci/mod-step-core.mjs'

const recorded = JSON.parse(
  readFileSync(new URL('./fixtures/validate-skeleton.json', import.meta.url), 'utf8')
)

// Notes as the CLI printed them for a richer mod (smoke §11.3, claude 2.1.289).
const richer = {
  success: true,
  contents: [
    {
      type: 'hooks',
      notes: [
        './register.ts hooks: session.start, classic.SessionStart, session.end, command.run{command=harnu-probe}, command.run{command=other}',
        './register.ts calls: $.http.fetch, $.prompt.submit, $.session.id',
        './register.ts env reads: HARNU_SPAWN_TOKEN'
      ]
    }
  ]
}

describe('parseValidateNotes', () => {
  it('notes parser', () => {
    expect(parseValidateNotes(recorded)).toEqual({
      hooks: ['session.start'],
      calls: [],
      envReads: []
    })
    expect(parseValidateNotes(richer)).toEqual({
      hooks: ['classic.SessionStart', 'command.run', 'session.end', 'session.start'],
      calls: ['$.http.fetch', '$.prompt.submit', '$.session.id'],
      envReads: ['HARNU_SPAWN_TOKEN']
    })
  })

  it('ignores the "(via fn, fn)" call-site annotations of claude 2.1.290', () => {
    const annotated = {
      success: true,
      contents: [
        {
          type: 'hooks',
          notes: [
            './register.ts hooks: session.start, classic.SessionStart',
            './register.ts calls: $.clock.after (via maybeDriftCheck, raceWithTimer, scheduleRetry), $.clock.every (via startHeartbeatOnce), $.http.fetch (via post), $.state.get (via doHello, maybeDriftCheck)',
            './register.ts env reads: HARNU_SPAWN_TOKEN (via doHello)'
          ]
        }
      ]
    }
    expect(parseValidateNotes(annotated)).toEqual({
      hooks: ['classic.SessionStart', 'session.start'],
      calls: ['$.clock.after', '$.clock.every', '$.http.fetch', '$.state.get'],
      envReads: ['HARNU_SPAWN_TOKEN']
    })
  })

  it('the marketplace trap', () => {
    expect(() => parseValidateNotes({ success: true, contents: [] })).toThrow(
      'validated as a marketplace'
    )
  })

  it('fails loudly when the notes shape changes', () => {
    expect(() =>
      parseValidateNotes({ success: true, contents: [{ type: 'hooks', notes: ['something new'] }] })
    ).toThrow(/no "hooks:" note/)
  })
})

describe('compareToManifest', () => {
  const manifest = { hooks: ['session.start'], calls: [], envReads: [] }

  it('is empty when the report equals the manifest', () => {
    expect(compareToManifest(parseValidateNotes(recorded), manifest)).toEqual([])
  })

  it('names every drift, in either direction', () => {
    const diffs = compareToManifest(parseValidateNotes(richer), manifest)
    expect(diffs.join('\n')).toContain('hooks')
    expect(diffs.join('\n')).toContain('$.http.fetch')
    expect(diffs.join('\n')).toContain('HARNU_SPAWN_TOKEN')
  })
})
