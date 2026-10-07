import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs script with no declaration file
import { scrubRecord } from '../../scripts/dev/companion-parity-export.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  rmSync(resolve(__dirname, '../fixtures/companion-parity/zzexport'), {
    recursive: true,
    force: true
  })
})

const rec = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  stream: 'zzexport',
  source: 'companion',
  owner: 'legacy',
  reason: 'mode-shadow',
  disposition: 'record-only',
  sk: 'aaaaaaaaaaaa',
  t: 1,
  k: 'state:working',
  cli: '2.1.290',
  mod: '0.1.0',
  ...extra
})

describe('companion-parity-export', () => {
  it('scrubs a second time and refuses a record that still names a path', () => {
    expect(scrubRecord(rec({ d: { n: 1, path: 'x', note: '/etc/passwd' }, extra: 1 }))).toEqual(
      rec({ d: { n: 1 } })
    )
    expect(scrubRecord(rec({ k: '/home/someone/x' }))).toBeNull()
    expect(scrubRecord({ v: 2 })).toBeNull()
  })

  it('writes the fixture, oldest generation first', () => {
    const ud = mkdtempSync(join(tmpdir(), 'hc-pe-'))
    dirs.push(ud)
    const parity = join(ud, 'companion', 'parity')
    mkdirSync(parity, { recursive: true })
    writeFileSync(join(parity, 'zzexport.1.ndjson'), JSON.stringify(rec({ t: 1 })) + '\n')
    writeFileSync(join(parity, 'zzexport.ndjson'), JSON.stringify(rec({ t: 2 })) + '\nnot json\n')
    const script = resolve(__dirname, '../../scripts/dev/companion-parity-export.mjs')
    const out = execFileSync(
      process.execPath,
      [script, '--user-data', ud, '--stream', 'zzexport', '--name', 'two'],
      { encoding: 'utf8' }
    )
    expect(out).toContain('2 records written')
    const text = readFileSync(
      resolve(__dirname, '../fixtures/companion-parity/zzexport/two.ndjson'),
      'utf8'
    )
    expect(
      text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).t)
    ).toEqual([1, 2])
  })
})
