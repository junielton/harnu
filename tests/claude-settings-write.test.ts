import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Regression suite for the hardened `~/.claude/settings.json` write layer
 * (issue #16, Phase 0). These pin the clobber class that wiped the file once
 * (9 KB → 162 B): an empty/failed read must NOT overwrite a non-empty file,
 * concurrent patches must serialize without a lost update, and an interrupted
 * write must leave the original intact. Also covers surgical-patch semantics
 * (only patched keys change, unknown keys + ordering survive, UNSET deletes,
 * nested dot-paths work).
 */

import {
  UNSET,
  applyPatch,
  patchClaudeSettings,
  updateClaudeSettings,
  writeClaudeSettings,
  readClaudeSettings,
  ClaudeSettingsCorruptError
} from '../src/main/claude-settings'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-settings-'))
  file = path.join(dir, 'settings.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function write(content: string): Promise<void> {
  await fs.writeFile(file, content, 'utf8')
}
async function read(): Promise<string> {
  return fs.readFile(file, 'utf8')
}

describe('applyPatch (pure)', () => {
  it('touches only patched keys and preserves unknown keys + ordering', () => {
    const obj = { model: 'sonnet', env: { A: '1' }, hooks: { Stop: [] }, custom: 42 }
    const out = applyPatch(obj, { tui: 'fullscreen' })
    expect(Object.keys(out)).toEqual(['model', 'env', 'hooks', 'custom', 'tui'])
    expect(out.model).toBe('sonnet')
    expect(out.env).toEqual({ A: '1' })
    expect(out.hooks).toEqual({ Stop: [] })
  })

  it('updates an existing key in place (no reordering)', () => {
    const obj = { a: 1, model: 'sonnet', z: 9 }
    const out = applyPatch(obj, { model: 'opus' })
    expect(Object.keys(out)).toEqual(['a', 'model', 'z'])
    expect(out.model).toBe('opus')
  })

  it('UNSET deletes a key', () => {
    const out = applyPatch({ model: 'sonnet', tui: 'fullscreen' }, { tui: UNSET })
    expect(out).toEqual({ model: 'sonnet' })
  })

  it('nested dot-paths set and create intermediate objects', () => {
    const out = applyPatch({}, { 'env.FOO': 'bar', 'permissions.defaultMode': 'plan' })
    expect(out).toEqual({ env: { FOO: 'bar' }, permissions: { defaultMode: 'plan' } })
  })

  it('nested UNSET deletes only the leaf', () => {
    const out = applyPatch({ env: { A: '1', B: '2' } }, { 'env.A': UNSET })
    expect(out).toEqual({ env: { B: '2' } })
  })
})

describe('patchClaudeSettings (on disk)', () => {
  it('changes only patched keys; hooks/statusLine + unknown keys survive byte-stable', async () => {
    const original = {
      model: 'sonnet',
      hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'http', url: 'x' }] }] },
      statusLine: { type: 'command', command: 'sh foo.sh' },
      somethingTheCatalogNeverHeardOf: { deep: [1, 2, 3] }
    }
    await write(JSON.stringify(original, null, 2) + '\n')

    await patchClaudeSettings(file, { tui: 'fullscreen' })

    const after = JSON.parse(await read())
    expect(after.tui).toBe('fullscreen')
    expect(after.hooks).toEqual(original.hooks)
    expect(after.statusLine).toEqual(original.statusLine)
    expect(after.somethingTheCatalogNeverHeardOf).toEqual(original.somethingTheCatalogNeverHeardOf)
    // original keys keep their order; the new key is appended last.
    expect(Object.keys(after)).toEqual([...Object.keys(original), 'tui'])
  })

  it('creates the file from scratch when none exists', async () => {
    await patchClaudeSettings(file, { model: 'opus' })
    expect(JSON.parse(await read())).toEqual({ model: 'opus' })
  })

  it('writes a pre-write backup of the prior bytes', async () => {
    await write('{ "model": "sonnet" }\n')
    await patchClaudeSettings(file, { tui: 'fullscreen' })
    expect(await fs.readFile(`${file}.backup`, 'utf8')).toBe('{ "model": "sonnet" }\n')
  })
})

describe('empty-read guard (clobber regression)', () => {
  it('aborts the write when the file is non-empty but unparseable', async () => {
    const corrupt = '{ this is not valid json but is definitely not empty ........... }'
    await write(corrupt)
    await expect(patchClaudeSettings(file, { model: 'opus' })).rejects.toBeInstanceOf(
      ClaudeSettingsCorruptError
    )
    // the original bytes are untouched — NOT clobbered to `{}`.
    expect(await read()).toBe(corrupt)
  })

  it('treats a whitespace-only file as empty and writes safely', async () => {
    await write('   \n')
    await patchClaudeSettings(file, { model: 'opus' })
    expect(JSON.parse(await read())).toEqual({ model: 'opus' })
  })

  it('aborts when the JSON is valid but not a plain object (array)', async () => {
    await write('[1, 2, 3]')
    await expect(patchClaudeSettings(file, { model: 'opus' })).rejects.toBeInstanceOf(
      ClaudeSettingsCorruptError
    )
    expect(await read()).toBe('[1, 2, 3]')
  })
})

describe('single-writer lock (no lost update)', () => {
  it('serializes concurrent patches so both keys land', async () => {
    await write('{}\n')
    await Promise.all([
      patchClaudeSettings(file, { model: 'opus' }),
      patchClaudeSettings(file, { tui: 'fullscreen' })
    ])
    const after = JSON.parse(await read())
    expect(after).toEqual({ model: 'opus', tui: 'fullscreen' })
  })

  it('serializes many concurrent increments without dropping any', async () => {
    await write('{ "n": 0 }\n')
    const bumps = Array.from({ length: 25 }, () =>
      updateClaudeSettings(file, (cur) => ({ ...cur, n: (cur.n as number) + 1 }))
    )
    await Promise.all(bumps)
    expect((JSON.parse(await read()) as { n: number }).n).toBe(25)
  })
})

describe('interrupted write leaves the original intact', () => {
  it('does not write the target when the mutate step throws', async () => {
    await write('{ "model": "sonnet" }\n')
    await expect(
      updateClaudeSettings(file, () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(JSON.parse(await read())).toEqual({ model: 'sonnet' })
    // no stray tmp files left behind
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('round-trips through readClaudeSettings / writeClaudeSettings atomically', async () => {
    await writeClaudeSettings(file, { model: 'haiku' })
    expect(await readClaudeSettings(file)).toEqual({ model: 'haiku' })
  })
})
