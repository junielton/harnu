// U3.6 AC-4/AC-8: the agent doc tells a session what to do when its compose up fails for lack of
// address pools or ports, and the user docs, changelog and marker say what the watcher does.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('docs/harnu-features.md (AC-4)', () => {
  const doc = read('docs/harnu-features.md')
  const at = doc.indexOf('**Docker capacity — when `compose up` fails.**')
  const para = at < 0 ? '' : doc.slice(at, doc.indexOf('\n\n', at))

  it('is marker v128', () => {
    expect(doc.split('\n')[0]).toMatch(/^<!-- harnu-features v135 /)
  })

  it('has the capacity paragraph', () => {
    expect(at).toBeGreaterThan(-1)
  })

  it('names both failures a session can hit', () => {
    expect(para).toContain('could not find an available, non-overlapping IPv4 address pool')
    expect(para).toContain('port is already allocated')
  })

  it('tells the session to raise an operator-owned blocker on its step and stop', () => {
    expect(para).toMatch(/mission_set_blocker/)
    expect(para).toMatch(/owner: 'operator'/)
    expect(para).toMatch(/stop/i)
  })

  it('says the session does not free capacity or retry on its own', () => {
    expect(para).toMatch(/do not (retry|stop|remove)/i)
  })
})

describe('user docs, changelog (AC-8)', () => {
  it('cleanup.md explains the watcher, the mark, the notification and that the hourly cap holds', () => {
    const page = read('docs/user/cleanup.md')
    const at = page.indexOf('**The capacity watcher.**')
    expect(at).toBeGreaterThan(-1)
    const text = page.slice(at, page.indexOf('\n\n', page.indexOf('\n\n', at) + 2))
    expect(text).toMatch(/low-water mark/i)
    expect(text).toMatch(/\b3\b/)
    expect(text).toMatch(/Activity/)
    expect(text).toMatch(/6 stacks an hour|hourly/i)
    expect(text).toMatch(/Docker Desktop/)
  })

  it('cleanup.md says the heads-up still fires when automatic cleanup is off or paused', () => {
    const page = read('docs/user/cleanup.md')
    const at = page.indexOf('**When there is nothing left to free.**')
    const text = page.slice(at, page.indexOf('\n\n', at))
    expect(text).toMatch(/switch is off|Docker switch/i)
    expect(text).toMatch(/Pause all autonomous cleanup|paused/i)
    expect(text).toMatch(/nothing will be freed|not acting|does not free/i)
  })

  it('containers.md points at the notification', () => {
    expect(read('docs/user/containers.md')).toMatch(/out of network slots|network slots/i)
  })

  it('the changelog has the watcher entry and the list-before-acknowledge entry', () => {
    const log = read('CHANGELOG.md')
    expect(log).toMatch(/capacity watcher/i)
    expect(log).toMatch(/list of what it would do|lists what it would do/i)
  })
})
