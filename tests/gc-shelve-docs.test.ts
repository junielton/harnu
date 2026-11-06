// The contracts shelving owes (U2.2 AC-8, U2.3a AC-7): a dated CHANGELOG entry that says what it does and
// that it is on but report-only first, the user page, and the agent awareness doc with its marker bumped.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8')

describe('shelving contracts', () => {
  it('the CHANGELOG has a dated entry: shelving restores by itself, is on by default and reports first', () => {
    const log = read('CHANGELOG.md')
    const start = log.indexOf('## 2026-11-05')
    expect(start).toBeGreaterThan(-1)
    const entry = log.slice(start, log.indexOf('## 2026-11-04'))
    expect(entry).toMatch(/shelv/i)
    expect(entry).toMatch(/comes back by itself/i)
    expect(entry).toMatch(/Shelving is on by default, and still only reports first/)
    expect(entry).toMatch(/report-only|only reports/i)
    expect(entry).not.toMatch(/Not switched on yet/)
    expect(entry).toMatch(/Restore first/)
  })

  it('the user page explains shelving, automatic restore, the first report and the archive guard', () => {
    const page = read('docs/user/cleanup.md')
    const at = page.indexOf('### Shelving idle worktrees')
    expect(at).toBeGreaterThan(-1)
    const section = page.slice(at, page.indexOf('### Before the first scan', at))
    expect(section).not.toMatch(/not switched on yet/i)
    expect(section).toMatch(/on by default/i)
    expect(section).toMatch(/Acknowledge first report/)
    expect(section).toMatch(/comes back by itself/i)
    expect(section).toMatch(/Restore first/)
    expect(section).toMatch(/Restore/)
    expect(section).toMatch(/git -C <repo> worktree add/)
    expect(section).toMatch(/branch stays/i)
  })

  it('the agent doc lists the new list_cleanup fields and carries a bumped marker', () => {
    const doc = read('docs/harnu-features.md')
    expect(doc.split('\n')[0]).toMatch(/^<!-- harnu-features v128 /)
    expect(doc).toMatch(/shelved: \[\{ id, folderAlias, branch, shelvedAt, idleDays, reason \}\]/)
    expect(doc).toMatch(/shelving: \{ enabled,\s+reportOnly, thresholdDays \}/)
    expect(doc).toMatch(/\*\*not\*\* a removed worktree/)
    expect(doc).toMatch(/SHELVED_RESTORE_FAILED/)
    expect(doc).toMatch(/\*\*A shelved worktree restores itself\*\*/)
  })
})
