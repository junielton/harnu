// The contracts shelving owes (U2.2 AC-8): a dated CHANGELOG entry that says it is off, the user page,
// and the agent awareness doc with its marker bumped.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8')

describe('shelving contracts', () => {
  it('the CHANGELOG has a dated entry saying shelving is off until restore lands', () => {
    const log = read('CHANGELOG.md')
    const start = log.indexOf('## 2026-11-05')
    expect(start).toBeGreaterThan(-1)
    const entry = log.slice(start, log.indexOf('## 2026-11-04'))
    expect(entry).toMatch(/shelv/i)
    expect(entry).toMatch(/off by default/i)
    expect(entry).toMatch(/Not switched on yet/)
    expect(entry).toMatch(/report-only|only reports/i)
  })

  it('the user page explains shelving and that it is off until restore lands', () => {
    const page = read('docs/user/cleanup.md')
    const at = page.indexOf('### Shelving idle worktrees')
    expect(at).toBeGreaterThan(-1)
    const section = page.slice(at, page.indexOf('### Before the first scan', at))
    expect(section).toMatch(/not switched on yet/i)
    expect(section).toMatch(/Restore/)
    expect(section).toMatch(/git -C <repo> worktree add/)
    expect(section).toMatch(/branch stays/i)
  })

  it('the agent doc lists the new list_cleanup fields and carries a bumped marker', () => {
    const doc = read('docs/harnu-features.md')
    expect(doc.split('\n')[0]).toMatch(/^<!-- harnu-features v121 /)
    expect(doc).toMatch(/shelved: \[\{ id, folderAlias, branch, shelvedAt, idleDays, reason \}\]/)
    expect(doc).toMatch(/shelving: \{ enabled,\s+reportOnly, thresholdDays \}/)
    expect(doc).toMatch(/\*\*not\*\* a removed worktree/)
  })
})
