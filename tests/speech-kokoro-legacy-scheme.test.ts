import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  userData: '',
  registered: [] as Array<{ scheme: string; privileges: Record<string, boolean> }>,
  handlers: new Map<string, (req: Request) => Promise<Response>>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  protocol: {
    registerSchemesAsPrivileged: (list: typeof state.registered) => {
      state.registered = list
    },
    handle: (scheme: string, fn: (req: Request) => Promise<Response>) => {
      state.handlers.set(scheme, fn)
    }
  }
}))

import {
  KOKORO_ENTRY_PATH,
  KOKORO_INSTALL_DIR,
  KOKORO_LEGACY_PROTOCOL,
  KOKORO_ORIGIN,
  KOKORO_PROTOCOL,
  KOKORO_REWRITES,
  migrateLegacyKokoroOrigin
} from '../src/main/speech-kokoro-plan'
import {
  migrateInstalledMirror,
  registerKokoroProtocol,
  registerKokoroScheme
} from '../src/main/speech-kokoro'

/** An entry file exactly as a pre-rename install wrote it: the old scheme baked in. */
const OLD_ENTRY = `const voices = "${KOKORO_REWRITES[0].replace.replace(KOKORO_ORIGIN, 'capy-voice://kokoro')}";`

function entryFile(): string {
  return path.join(state.userData, KOKORO_INSTALL_DIR, ...KOKORO_ENTRY_PATH.slice(1).split('/'))
}

beforeEach(() => {
  state.userData = mkdtempSync(path.join(os.tmpdir(), 'harnu-kokoro-legacy-'))
  state.registered = []
  state.handlers.clear()
  mkdirSync(path.dirname(entryFile()), { recursive: true })
  writeFileSync(entryFile(), OLD_ENTRY, 'utf8')
})

afterEach(() => rmSync(state.userData, { recursive: true, force: true }))

describe('legacy capy-voice:// scheme (pre-rename installs)', () => {
  it('the fixture really carries the old scheme', () => {
    expect(OLD_ENTRY).toContain('capy-voice://kokoro/hf/')
    expect(OLD_ENTRY).not.toContain('harnu-voice')
  })

  it('migrateLegacyKokoroOrigin rewrites the baked origin, idempotently', () => {
    const once = migrateLegacyKokoroOrigin(OLD_ENTRY)
    expect(once).toContain(`${KOKORO_ORIGIN}/hf/`)
    expect(once).not.toContain('capy-voice')
    expect(migrateLegacyKokoroOrigin(once)).toBe(once)
    expect(migrateLegacyKokoroOrigin('nothing to do')).toBe('nothing to do')
  })

  it('registers both schemes as privileged with the same capabilities', () => {
    registerKokoroScheme()
    const byName = new Map(state.registered.map((r) => [r.scheme, r.privileges]))
    expect([...byName.keys()].sort()).toEqual([KOKORO_LEGACY_PROTOCOL, KOKORO_PROTOCOL].sort())
    expect(byName.get(KOKORO_LEGACY_PROTOCOL)).toEqual(byName.get(KOKORO_PROTOCOL))
  })

  it('serves an OLD install through the legacy scheme, and the new one', async () => {
    registerKokoroProtocol()
    await migrateInstalledMirror() // let the boot-time migration settle
    for (const scheme of [KOKORO_LEGACY_PROTOCOL, KOKORO_PROTOCOL]) {
      const handler = state.handlers.get(scheme)
      expect(handler).toBeTypeOf('function')
      const res = await (handler as (r: Request) => Promise<Response>)(
        new Request(`${scheme}://kokoro${KOKORO_ENTRY_PATH}`)
      )
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('/hf/')
    }
  })

  it('rewrites the baked entry file on disk at boot, so the alias can be dropped later', async () => {
    await migrateInstalledMirror()
    const onDisk = readFileSync(entryFile(), 'utf8')
    expect(onDisk).toContain(`${KOKORO_ORIGIN}/hf/`)
    expect(onDisk).not.toContain('capy-voice')
  })

  it('does nothing when no voice is installed', async () => {
    rmSync(path.join(state.userData, KOKORO_INSTALL_DIR), { recursive: true, force: true })
    await expect(migrateInstalledMirror()).resolves.toBeUndefined()
  })
})

describe('both CSPs allow both voice schemes', () => {
  const root = path.resolve(__dirname, '..')
  const html = readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
  const main = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  it.each([
    ['index.html', html],
    ['main CSP_POLICY', main]
  ])('%s has script-src and connect-src for harnu-voice: and capy-voice:', (_n, src) => {
    expect(src).toMatch(/script-src [^;]*harnu-voice:[^;]*capy-voice:/)
    expect(src).toMatch(/connect-src [^;]*harnu-voice:[^;]*capy-voice:/)
  })
})
