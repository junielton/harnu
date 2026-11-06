// The contracts automatic pausing owes (U3.5 AC-7): a CHANGELOG entry and the user pages, telling
// the truth about when Cleanup pauses a stack and what protects one.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8')

describe('automatic pausing contracts', () => {
  it('the CHANGELOG says when a stack is paused, what protects one, and the line it writes', () => {
    const log = read('CHANGELOG.md')
    const start = log.indexOf('## 2026-11-05')
    const entry = log.slice(start, log.indexOf('## 2026-11-04'))
    expect(entry).toMatch(/Cleanup now pauses idle Docker stacks by itself/)
    expect(entry).toMatch(/2 hours/)
    expect(entry).toMatch(/30 minutes/)
    expect(entry).toMatch(/6 stacks an hour|6 pauses an hour/)
    expect(entry).toMatch(/Keep/)
    expect(entry).toMatch(/browser pane/)
    expect(entry).toMatch(/Acknowledge first report/)
    expect(entry).toMatch(/bring back:/)
    expect(entry).not.toMatch(/Nothing pauses a stack by itself yet/)
    expect(entry).not.toMatch(/nothing in Docker is paused or removed yet/)
  })

  it('docs/user/cleanup.md explains when Cleanup pauses a stack and what protects one', () => {
    const page = read('docs/user/cleanup.md')
    const at = page.indexOf('### Docker: pausing and garbage')
    const section = page.slice(at, page.indexOf('### Before the first scan', at))
    expect(section).toMatch(/When Cleanup pauses a stack/)
    expect(section).toMatch(/2 hours/)
    expect(section).toMatch(/30 minutes/)
    expect(section).toMatch(/6 stacks an hour|6 pauses an hour/)
    expect(section).toMatch(/Keep/)
    expect(section).toMatch(/working session/)
    expect(section).toMatch(/browser pane/)
    expect(section).toMatch(/connection/)
    expect(section).toMatch(/shelve/i)
    expect(section).not.toMatch(/Only the part that chooses which stacks to pause is still missing/)
    expect(section).not.toMatch(/nothing yet in Docker/i)
  })

  it('docs/user/containers.md says Cleanup pauses idle stacks by itself, and where to read the rules', () => {
    const page = read('docs/user/containers.md')
    const at = page.indexOf('## Paused stacks')
    const section = page.slice(at, page.indexOf('\n## ', at + 5))
    expect(section).toMatch(/Cleanup pauses an idle stack by itself/)
    expect(section).toMatch(/cleanup\.md/)
    expect(section).not.toMatch(/Nothing pauses a stack by itself yet/)
  })
})
