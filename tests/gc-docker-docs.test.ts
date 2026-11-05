// The contracts Docker autonomy owes (U3.1 AC-7): a dated CHANGELOG entry, the user page, and the
// spec amendment recorded as the first commit's content.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8')

describe('Docker autonomy contracts', () => {
  it('the CHANGELOG says what it is, that it only reports first, and that nothing is removed yet', () => {
    const log = read('CHANGELOG.md')
    const start = log.indexOf('## 2026-11-05')
    const entry = log.slice(start, log.indexOf('## 2026-11-04'))
    expect(entry).toMatch(/Docker switch of its own/)
    expect(entry).toMatch(/Acknowledge first report/)
    expect(entry).toMatch(/nothing in Docker is removed yet/)
    expect(entry).toMatch(/Pause all autonomous cleanup/)
    expect(entry).toMatch(/actor `autopilot`/)
  })

  it('the user page explains the switch, the report-only first cycle, the limits and the global pause', () => {
    const page = read('docs/user/cleanup.md')
    const at = page.indexOf('### Docker: pausing and garbage')
    expect(at).toBeGreaterThan(-1)
    const section = page.slice(at, page.indexOf('### Before the first scan', at))
    expect(section).toMatch(/\*\*Paused\*\*/)
    expect(section).toMatch(/Acknowledge first report/)
    expect(section).toMatch(/own/)
    expect(section).toMatch(/Pause all autonomous cleanup/)
    expect(section).toMatch(/volumes? (is|are) never removed|volumes kept/i)
    expect(section).toMatch(/is not built yet, so nothing is removed this way/i)
  })

  it('the design spec records the 2026-11-05 decisions in an Amendments section', () => {
    const spec = read('docs/specs/2026-10-29-autonomous-cleanup-design.md')
    const at = spec.indexOf('## 10. Amendments (2026-11-05)')
    expect(at).toBeGreaterThan(-1)
    const amend = spec.slice(at)
    expect(amend).toMatch(/AC-U3a restated/)
    expect(amend).toMatch(/Paused.*Pausada/s)
    expect(amend).toMatch(/\*\*2 h\*\*/)
    expect(amend).toMatch(/\*\*30\s+min\*\*/)
  })
})
