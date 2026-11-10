import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_YOUR_MOVE_MODE,
  effectiveMode,
  isFolderDisabled,
  needsCursorReset,
  readYourMovePrefs,
  writeYourMovePrefs,
  type YourMovePrefs
} from '../../src/main/your-move/prefs'

const prefs = (over: Partial<YourMovePrefs> = {}): YourMovePrefs => ({
  version: 1,
  disabledFolders: [],
  firstRunNoticeSeen: false,
  midTurnLive: false,
  ...over
})

describe('effectiveMode', () => {
  it('effectiveMode: unset reads DEFAULT_YOUR_MOVE_MODE; an explicit choice wins', () => {
    expect(DEFAULT_YOUR_MOVE_MODE).toBe('off') // U1 ships Off; the default moves in U5
    expect(effectiveMode(prefs())).toBe(DEFAULT_YOUR_MOVE_MODE)
    expect(effectiveMode(prefs({ mode: 'observe' }))).toBe('observe')
    expect(effectiveMode(prefs({ mode: 'off' }))).toBe('off')
    expect(effectiveMode(prefs({ mode: 'live' }))).toBe('live')
  })
})

describe('needsCursorReset', () => {
  it('needsCursorReset: off→observe and off→live true; observe→live false; live→off false', () => {
    expect(needsCursorReset('off', 'observe')).toBe(true)
    expect(needsCursorReset('off', 'live')).toBe(true)
    expect(needsCursorReset('observe', 'live')).toBe(false)
    expect(needsCursorReset('live', 'off')).toBe(false)
    expect(needsCursorReset('off', 'off')).toBe(false)
  })
})

describe('isFolderDisabled', () => {
  it('a disabledFolders path disables nested folders', () => {
    const p = prefs({ disabledFolders: ['/org/proj/www'] })
    expect(isFolderDisabled(p, '/org/proj/www')).toBe(true)
    expect(isFolderDisabled(p, '/org/proj/www/')).toBe(true)
    expect(isFolderDisabled(p, '/org/proj/www/.claude/worktrees/feat-x')).toBe(true)
    expect(isFolderDisabled(p, '/org/proj/www-other')).toBe(false)
    expect(isFolderDisabled(p, '/org/proj')).toBe(false)
  })
})

describe('prefs file', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-prefs-'))
    file = path.join(dir, 'your-move-prefs.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads defaults when the file is missing or corrupt', async () => {
    expect(await readYourMovePrefs(file)).toEqual(prefs())
    await writeFile(file, '{ nope')
    expect(await readYourMovePrefs(file)).toEqual(prefs())
  })

  it('merges a patch, persists it at mode 0600 and ignores junk fields', async () => {
    const out = await writeYourMovePrefs(file, {
      mode: 'observe',
      disabledFolders: ['/a', 7 as never],
      midTurnLive: 'yes' as never
    })
    expect(out).toEqual(prefs({ mode: 'observe', disabledFolders: ['/a'] }))
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8')).mode).toBe('observe')
    expect(await writeYourMovePrefs(file, { firstRunNoticeSeen: true })).toMatchObject({
      mode: 'observe',
      firstRunNoticeSeen: true
    })
  })

  it('an unknown mode in the file reads as unset', async () => {
    await writeFile(file, JSON.stringify({ version: 1, mode: 'turbo' }))
    expect((await readYourMovePrefs(file)).mode).toBeUndefined()
  })
})
