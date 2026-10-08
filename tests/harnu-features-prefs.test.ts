import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: { handle: vi.fn() }
}))

import {
  HARNU_FEATURES_VERSION,
  parseFeaturesVersion,
  readHarnuFeaturesEnabled,
  writeHarnuFeaturesEnabled
} from '../src/main/harnu-features'

/**
 * The self-awareness toggle's pref file moved `capy-features.json` →
 * `harnu-features.json`. The one-time userData migration copies the old directory
 * verbatim, so an existing install's choice sits under the OLD name: it must be
 * honoured as a fallback, and never be written again.
 */
describe('harnu-features pref file', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'harnu-features-'))
  })
  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('defaults to ON when neither file exists', async () => {
    expect(await readHarnuFeaturesEnabled()).toBe(true)
  })

  it('falls back to the legacy capy-features.json when the new file is missing', async () => {
    writeFileSync(join(userDataDir, 'capy-features.json'), '{"enabled":false}\n')
    expect(await readHarnuFeaturesEnabled()).toBe(false)
  })

  it('prefers harnu-features.json over the legacy file', async () => {
    writeFileSync(join(userDataDir, 'capy-features.json'), '{"enabled":false}\n')
    writeFileSync(join(userDataDir, 'harnu-features.json'), '{"enabled":true}\n')
    expect(await readHarnuFeaturesEnabled()).toBe(true)
  })

  it('falls back to the legacy file when the new one is corrupt', async () => {
    writeFileSync(join(userDataDir, 'harnu-features.json'), '{torn')
    writeFileSync(join(userDataDir, 'capy-features.json'), '{"enabled":false}\n')
    expect(await readHarnuFeaturesEnabled()).toBe(false)
  })

  it('writes only harnu-features.json and leaves the legacy file alone', async () => {
    writeFileSync(join(userDataDir, 'capy-features.json'), '{"enabled":false}\n')
    await writeHarnuFeaturesEnabled(true)
    expect(JSON.parse(readFileSync(join(userDataDir, 'harnu-features.json'), 'utf8'))).toEqual({
      enabled: true
    })
    expect(readFileSync(join(userDataDir, 'capy-features.json'), 'utf8')).toBe(
      '{"enabled":false}\n'
    )
    expect(await readHarnuFeaturesEnabled()).toBe(true)
  })

  it('does not create the legacy file on a fresh install', async () => {
    await writeHarnuFeaturesEnabled(false)
    expect(existsSync(join(userDataDir, 'capy-features.json'))).toBe(false)
  })
})

describe('harnu-features doc marker', () => {
  it('parses the shipped doc marker', () => {
    expect(HARNU_FEATURES_VERSION).toBe('v80')
  })

  it('accepts both the harnu- and the pre-rename capy- marker prefix', () => {
    expect(parseFeaturesVersion('<!-- harnu-features v9 (2026-10-03) -->')).toBe('v9')
    expect(parseFeaturesVersion('<!-- capy-features v66 (2026-10-03) -->')).toBe('v66')
    expect(parseFeaturesVersion('no marker')).toBe('v0')
  })
})
