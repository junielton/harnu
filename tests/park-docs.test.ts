// The contracts the pause executor owes (U3.4 AC-7): a CHANGELOG entry, the user pages, and the
// agent-facing doc, each telling the truth about what shipped.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8')

describe('pause executor contracts', () => {
  it('the CHANGELOG says what a pause keeps, what it records, and what the hint is now', () => {
    const log = read('CHANGELOG.md')
    const start = log.indexOf('## 2026-11-05')
    const entry = log.slice(start, log.indexOf('## 2026-11-04'))
    expect(entry).toMatch(/Paused/)
    expect(entry).toMatch(/compose down/)
    expect(entry).toMatch(/volumes (are|stay) kept|never removes? (a|its) volumes?/i)
    expect(entry).toMatch(/docker compose .*up -d/)
    expect(entry).toMatch(/never `docker start`/)
    expect(entry).toMatch(/anonymous volume/)
    expect(entry).toMatch(/database/)
    expect(entry).toMatch(/`paused`/)
  })

  it('docs/user/containers.md explains Paused and how to bring a stack back', () => {
    const page = read('docs/user/containers.md')
    const at = page.indexOf('## Paused stacks')
    expect(at).toBeGreaterThan(-1)
    const section = page.slice(at, page.indexOf('\n## ', at + 5))
    expect(section).toMatch(/\*\*Paused\*\*/)
    expect(section).toMatch(/compose down/)
    expect(section).toMatch(/volumes? (is|are|stay) kept|volumes are never removed/i)
    expect(section).toMatch(/To bring it back/)
    expect(section).toMatch(/up -d/)
    expect(section).toMatch(/--build/)
    expect(section).toMatch(/ports/i)
    // the undo section no longer promises `docker start` for a stopped compose stack
    const recent = page.slice(page.indexOf('## Recent and undo'), page.indexOf('## When docker'))
    expect(recent).toMatch(/compose/)
    expect(recent).toMatch(/standalone container/)
  })

  it('docs/user/cleanup.md says which stacks are never paused on their own', () => {
    const page = read('docs/user/cleanup.md')
    const at = page.indexOf('### Docker: pausing and garbage')
    const section = page.slice(at, page.indexOf('### Before the first scan', at))
    expect(section).toMatch(/anonymous volume/)
    expect(section).toMatch(/database/)
    expect(section).toMatch(/changed since decided|re-checks/i)
    expect(section).toMatch(/\[Paused\]|Paused stacks/)
  })

  it('docs/harnu-features.md documents the paused list and the restore command', () => {
    const doc = read('docs/harnu-features.md')
    expect(doc.split('\n')[0]).toMatch(/^<!-- harnu-features v130 /)
    expect(doc).toMatch(/\*\*`paused`\*\*/)
    expect(doc).toMatch(/\*\*`restoreCommand`\*\*/)
    expect(doc).toMatch(/never `docker start`/)
  })
})
