import { describe, it, expect } from 'vitest'
import {
  isOurStatusLine,
  mergeStatusLine,
  stripStatusLine,
  buildWriterScript,
  isWriterStale,
  isOurWriterScript,
  WRITER_SCRIPT_VERSION
} from '../src/main/statusline-install'

const OUR = 'sh /home/u/.config/Harnu/statusline/statusline-writer.sh'
const OLD_CAPY = 'sh /home/u/.config/Capy/statusline/statusline-writer.sh' // pre-rename userData
const FOREIGN = { type: 'command', command: 'node /home/u/bin/my-statusline.js' }

describe('isOurStatusLine', () => {
  it('matches by the writer-script path, not a loose substring', () => {
    expect(isOurStatusLine({ type: 'command', command: OUR })).toBe(true)
    // contains "capy" but does NOT point at our writer → not ours
    expect(isOurStatusLine({ type: 'command', command: 'node /home/u/capy/thing.js' })).toBe(false)
  })

  it('does not claim a foreign script that merely contains statusline-writer.sh', () => {
    for (const command of [
      'sh /home/u/bin/my-statusline-writer.sh',
      'sh /home/u/tools/statusline/statusline-writer.sh',
      'sh /home/u/.config/other-app/statusline/statusline-writer.sh',
      'node /home/u/bin/statusline-writer.sh'
    ])
      expect(isOurStatusLine({ type: 'command', command })).toBe(false)
  })

  it.each([
    'sh /home/u/.config/Capy/statusline/statusline-writer.sh',
    'sh "/home/u/.config/capy/statusline/statusline-writer.sh"',
    'sh /home/u/.config/Harnu/statusline/statusline-writer.sh',
    'sh /home/u/.config/harnu/statusline/statusline-writer.sh',
    'cmd /c "C:\\Users\\u\\AppData\\Roaming\\Capy\\statusline\\statusline-writer.cmd"'
  ])('claims our writer under a Capy/Harnu userData dir: %s', (command) => {
    expect(isOurStatusLine({ type: 'command', command })).toBe(true)
  })

  it('is false for a foreign command, undefined, or a non-object', () => {
    expect(isOurStatusLine(FOREIGN)).toBe(false)
    expect(isOurStatusLine(undefined)).toBe(false)
    expect(isOurStatusLine('sh ...')).toBe(false)
  })

  it('survives Claude Code rewriting settings.json (identity is the preserved command, not a sentinel)', () => {
    // CC strips unknown keys inside handlers; our identity is the `command`
    // string it must round-trip. A bare {type,command} with no extra keys is ours.
    expect(isOurStatusLine({ type: 'command', command: OUR })).toBe(true)
  })
})

describe('mergeStatusLine', () => {
  it('installs ours when no statusLine exists', () => {
    const { next, installed, foreignPreserved } = mergeStatusLine({ hooks: {} }, OUR)
    expect(installed).toBe(true)
    expect(foreignPreserved).toBe(false)
    expect((next.statusLine as { command: string }).command).toBe(OUR)
    expect(next.hooks).toEqual({}) // preserves other keys
  })

  it('preserves a FOREIGN statusLine, backing ours up without clobbering', () => {
    const { next, installed, foreignPreserved } = mergeStatusLine({ statusLine: FOREIGN }, OUR)
    expect(installed).toBe(false)
    expect(foreignPreserved).toBe(true)
    expect(next.statusLine).toEqual(FOREIGN) // untouched
    expect((next.statusLine_harnu as { command: string }).command).toBe(OUR) // our backup
    expect('statusLine_capy' in next).toBe(false)
  })

  it('replaces a stale legacy backup (statusLine_capy / statusLine_om2tab) when preserving a foreign line', () => {
    const { next } = mergeStatusLine(
      {
        statusLine: FOREIGN,
        statusLine_capy: { type: 'command', command: OLD_CAPY },
        statusLine_om2tab: { type: 'command', command: OLD_CAPY }
      },
      OUR
    )
    expect(next.statusLine).toEqual(FOREIGN)
    expect((next.statusLine_harnu as { command: string }).command).toBe(OUR)
    expect('statusLine_capy' in next).toBe(false)
    expect('statusLine_om2tab' in next).toBe(false)
  })

  it('preserves a user statusLine named my-statusline-writer.sh and stashes ours as the backup', () => {
    const mine = { type: 'command', command: 'sh /home/u/bin/my-statusline-writer.sh' }
    const { next, installed, foreignPreserved } = mergeStatusLine({ statusLine: mine }, OUR)
    expect(installed).toBe(false)
    expect(foreignPreserved).toBe(true)
    expect(next.statusLine).toEqual(mine)
  })

  it('treats the CURRENT command as ours whatever its userData dir is called (dev/verify instances)', () => {
    const current = 'sh /tmp/some-verify-dir/statusline/statusline-writer.sh'
    const { next, installed } = mergeStatusLine(
      { statusLine: { type: 'command', command: current } },
      current
    )
    expect(installed).toBe(true)
    expect((next.statusLine as { command: string }).command).toBe(current)
  })

  it('is idempotent when ours is already installed (updates path, no duplication)', () => {
    const existing = { statusLine: { type: 'command', command: OUR } }
    const { next, installed, foreignPreserved } = mergeStatusLine(existing, OUR)
    expect(installed).toBe(true)
    expect(foreignPreserved).toBe(false)
    expect((next.statusLine as { command: string }).command).toBe(OUR)
    expect('statusLine_harnu' in next).toBe(false)
  })

  it('rewrites a statusLine pointing at the OLD Capy userData path to the current one', () => {
    const existing = {
      statusLine: { type: 'command', command: OLD_CAPY },
      statusLine_capy: { type: 'command', command: OLD_CAPY },
      statusLine_om2tab: { type: 'command', command: OLD_CAPY }
    }
    const { next, installed, foreignPreserved } = mergeStatusLine(existing, OUR)
    expect(installed).toBe(true)
    expect(foreignPreserved).toBe(false)
    expect(next.statusLine).toEqual({ type: 'command', command: OUR })
    expect('statusLine_capy' in next).toBe(false)
    expect('statusLine_om2tab' in next).toBe(false)
    expect('statusLine_harnu' in next).toBe(false)
  })
})

describe('stripStatusLine', () => {
  it('removes our statusLine (and any backup)', () => {
    const settings = {
      statusLine: { type: 'command', command: OUR },
      statusLine_harnu: { type: 'command', command: OUR },
      statusLine_capy: { type: 'command', command: OLD_CAPY },
      hooks: {}
    }
    const next = stripStatusLine(settings)
    expect('statusLine' in next).toBe(false)
    expect('statusLine_harnu' in next).toBe(false)
    expect('statusLine_capy' in next).toBe(false)
    expect(next.hooks).toEqual({})
  })

  it('no-ops on a foreign statusLine (preserves it) but still drops our backup', () => {
    const next = stripStatusLine({
      statusLine: FOREIGN,
      statusLine_harnu: { type: 'command', command: OUR }
    })
    expect(next.statusLine).toEqual(FOREIGN)
    expect('statusLine_harnu' in next).toBe(false)
  })

  it('also drops the legacy pre-rebrand backup key (statusLine_om2tab)', () => {
    const next = stripStatusLine({ statusLine_om2tab: { type: 'command', command: OUR } })
    expect('statusLine_om2tab' in next).toBe(false)
  })

  it('no-ops when there is no statusLine at all', () => {
    expect(stripStatusLine({ hooks: {} })).toEqual({ hooks: {} })
  })

  describe('strict mode (exactCommand — the exit-cleanup identity)', () => {
    const OTHER_INSTANCE = 'sh /tmp/harnu-verify/statusline/statusline-writer.sh'

    it('strips only a statusLine whose command is exactly ours', () => {
      const next = stripStatusLine({ statusLine: { type: 'command', command: OUR } }, OUR)
      expect('statusLine' in next).toBe(false)
    })

    it("leaves another Capy instance's statusLine alone (dev/verify exit must not kill prod telemetry)", () => {
      const settings = { statusLine: { type: 'command', command: OTHER_INSTANCE } }
      const next = stripStatusLine(settings, OUR)
      expect(next.statusLine).toEqual({ type: 'command', command: OTHER_INSTANCE })
    })

    it('drops backup keys only when they are exactly ours', () => {
      const next = stripStatusLine(
        {
          statusLine_harnu: { type: 'command', command: OTHER_INSTANCE },
          statusLine_capy: { type: 'command', command: OTHER_INSTANCE },
          statusLine_om2tab: { type: 'command', command: OUR }
        },
        OUR
      )
      expect('statusLine_harnu' in next).toBe(true) // another instance's backup survives
      expect('statusLine_capy' in next).toBe(true)
      expect('statusLine_om2tab' in next).toBe(false) // exact match → dropped
    })

    it('leaves a foreign statusLine untouched', () => {
      const next = stripStatusLine({ statusLine: FOREIGN }, OUR)
      expect(next.statusLine).toEqual(FOREIGN)
    })
  })
})

describe('buildWriterScript', () => {
  it('POSIX: carries the version header and writes stdin into the inbox dir', () => {
    const sh = buildWriterScript('sh', '/u/.config/Harnu/statusline/inbox')
    expect(sh).toContain(`# harnu-writer v${WRITER_SCRIPT_VERSION}`)
    expect(sh).not.toContain('capy-writer')
    expect(sh).toContain('/u/.config/Harnu/statusline/inbox')
    expect(sh).toMatch(/\bcat\b/)
  })

  it('Windows: carries the version header and writes stdin into the inbox dir', () => {
    const cmd = buildWriterScript('cmd', 'C:\\u\\Harnu\\statusline\\inbox')
    expect(cmd).toContain(`harnu-writer v${WRITER_SCRIPT_VERSION}`)
    expect(cmd).toContain('C:\\u\\Harnu\\statusline\\inbox')
    expect(cmd).toMatch(/\bmore\b/)
  })
})

describe('isWriterStale', () => {
  it('is stale when absent', () => {
    expect(isWriterStale(null)).toBe(true)
  })
  it('is fresh when the current harnu version header is present', () => {
    expect(isWriterStale(`#!/bin/sh\n# harnu-writer v${WRITER_SCRIPT_VERSION}\ncat > x`)).toBe(
      false
    )
  })
  // A legacy-marked script is recognized as ours but MUST be rewritten: it was
  // copied over by the userData migration and still embeds the OLD inbox dir.
  it.each(['capy', 'om2tab'])(
    'is stale for the legacy %s-writer marker (rewritten, not kept)',
    (m) => {
      expect(isWriterStale(`#!/bin/sh\n# ${m}-writer v${WRITER_SCRIPT_VERSION}\ncat > x`)).toBe(
        true
      )
    }
  )
  it('is stale when the version header is for a different version', () => {
    expect(isWriterStale('#!/bin/sh\n# harnu-writer v0\ncat > x')).toBe(true)
  })
})

describe('isOurWriterScript', () => {
  it.each(['harnu', 'capy', 'om2tab'])('recognizes the %s-writer marker as ours', (m) => {
    expect(isOurWriterScript(`#!/bin/sh\n# ${m}-writer v1\ncat > x`)).toBe(true)
  })
  it('does not claim an arbitrary script', () => {
    expect(isOurWriterScript('#!/bin/sh\necho hi')).toBe(false)
  })
})
