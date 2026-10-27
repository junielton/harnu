import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { EditorSetting } from '../src/main/editor-launch'

/**
 * T581 — the `external:openInEditor` handler (main process). The launcher is
 * exercised with `child_process.spawn` and the stored editor setting mocked:
 * a GUI editor is spawned detached with the exact argv (AC-1/2/4), a terminal
 * editor is resolved and handed back for a pane (AC-3), and a missing binary is
 * a typed failure, never a silent no-op (AC-5).
 */

const handlers = new Map<string, (...a: unknown[]) => unknown>()
let setting: EditorSetting = { id: 'vscode' }
/** Executables that "exist" for the spawn mock; anything else ENOENTs. */
let installed = new Set<string>()
const spawnCalls: Array<{ cmd: string; args: string[]; opts: unknown }> = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown): void => void handlers.set(ch, fn)
  },
  shell: {}
}))
vi.mock('../src/main/settings', () => ({ readEditorSetting: async () => setting }))
vi.mock('../src/main/appimage-env', () => ({ spawnEnvOnce: async () => ({ PATH: '/fake/bin' }) }))
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: (cmd: string, args: string[], opts: unknown) => {
    spawnCalls.push({ cmd, args, opts })
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = (): void => {}
    queueMicrotask(() => child.emit(installed.has(cmd) ? 'spawn' : 'error', new Error('ENOENT')))
    return child
  }
}))
// A terminal editor is "found" when its absolute path is in `installed`.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    statSync: (p: string) => {
      if (installed.has(p)) return { isFile: () => true }
      throw new Error('ENOENT')
    },
    accessSync: (p: string) => {
      if (!installed.has(p)) throw new Error('ENOENT')
    }
  }
})

import { registerExternal, findExecutable } from '../src/main/external'

async function openInEditor(p: unknown): Promise<Record<string, unknown>> {
  return (await handlers.get('external:openInEditor')!({}, p)) as Record<string, unknown>
}

beforeEach(() => {
  handlers.clear()
  spawnCalls.length = 0
  setting = { id: 'vscode' }
  installed = new Set()
  registerExternal()
})

describe('external:openInEditor', () => {
  it('rejects a relative or empty path before launching anything', async () => {
    expect(await openInEditor('rel/path')).toMatchObject({ ok: false, code: 'invalid-path' })
    expect(await openInEditor('')).toMatchObject({ ok: false, code: 'invalid-path' })
    expect(await openInEditor(undefined)).toMatchObject({ ok: false, code: 'invalid-path' })
    expect(spawnCalls).toHaveLength(0)
  })

  it('default setting spawns `code -- <path>` detached, like before T581 (AC-1)', async () => {
    installed.add('code')
    expect(await openInEditor('/w/proj')).toEqual({ ok: true, mode: 'gui' })
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]).toMatchObject({
      cmd: 'code',
      args: ['--', '/w/proj'],
      opts: { detached: true, stdio: 'ignore' }
    })
  })

  it('a GUI preset launches its own binary, falling through candidates (AC-2)', async () => {
    setting = { id: 'zed' }
    installed.add('zeditor') // `zed` is missing, the distro-named binary exists
    expect(await openInEditor('/w/proj')).toEqual({ ok: true, mode: 'gui' })
    expect(spawnCalls.map((c) => c.cmd)).toEqual(['zed', 'zeditor'])
    expect(spawnCalls[1].args).toEqual(['/w/proj'])
  })

  it('custom `foo --bar {path}` spawns foo with argv [--bar, <path>], no shell (AC-4)', async () => {
    setting = { id: 'custom', customCommand: 'foo --bar {path}' }
    installed.add('foo')
    const dir = '/w/my folder; echo $HOME `id` && true'
    expect(await openInEditor(dir)).toEqual({ ok: true, mode: 'gui' })
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].cmd).toBe('foo')
    expect(spawnCalls[0].args).toEqual(['--bar', dir])
    expect(spawnCalls[0].opts).not.toHaveProperty('shell')
  })

  it('a missing GUI binary is a typed not-found, never a silent no-op (AC-5)', async () => {
    setting = { id: 'cursor' }
    const res = await openInEditor('/w/proj')
    expect(res).toMatchObject({
      ok: false,
      code: 'not-found',
      editorId: 'cursor',
      name: 'Cursor',
      command: 'cursor'
    })
    expect(String(res.error)).toContain('`cursor` not found on PATH')
    expect(String(res.error)).toContain('Settings → General → Editor')
  })

  it('a missing VS Code keeps its install-command hint (AC-5)', async () => {
    const res = await openInEditor('/w/proj')
    expect(res).toMatchObject({ ok: false, code: 'not-found', editorId: 'vscode', command: 'code' })
    expect(String(res.error)).toContain("Install 'code' command in PATH")
  })

  it('an empty custom command is bad-command (AC-5)', async () => {
    setting = { id: 'custom', customCommand: '  ' }
    expect(await openInEditor('/w/proj')).toMatchObject({ ok: false, code: 'bad-command' })
    expect(spawnCalls).toHaveLength(0)
  })

  it('a terminal editor is resolved, not spawned: cmd + args come back for a pane (AC-3)', async () => {
    setting = { id: 'neovim' }
    installed.add('/fake/bin/nvim')
    expect(await openInEditor('/w/proj')).toEqual({
      ok: true,
      mode: 'terminal',
      name: 'Neovim',
      cmd: 'nvim',
      args: ['/w/proj']
    })
    expect(spawnCalls).toHaveLength(0)
  })

  it('a custom command flagged "runs in a terminal" resolves like a terminal preset (AC-3)', async () => {
    setting = { id: 'custom', customCommand: 'nvim -R {path}', customTerminal: true }
    installed.add('/fake/bin/nvim')
    expect(await openInEditor('/w/a b')).toMatchObject({
      ok: true,
      mode: 'terminal',
      cmd: 'nvim',
      args: ['-R', '/w/a b']
    })
  })

  it('a terminal editor that is not on PATH is not-found (AC-5)', async () => {
    setting = { id: 'helix' }
    const res = await openInEditor('/w/proj')
    expect(res).toMatchObject({ ok: false, code: 'not-found', command: 'hx' })
    expect(String(res.error)).toContain('`hx` not found on PATH')
  })
})

describe('findExecutable', () => {
  it('searches PATH entries for a bare name and checks an absolute path as given', () => {
    installed.add('/a/bin/tool').add('/abs/tool')
    expect(findExecutable('tool', '/x:/a/bin', 'linux')).toBe(true)
    expect(findExecutable('tool', '/x:/y', 'linux')).toBe(false)
    expect(findExecutable('/abs/tool', '', 'linux')).toBe(true)
    expect(findExecutable('/abs/other', '', 'linux')).toBe(false)
  })
})
