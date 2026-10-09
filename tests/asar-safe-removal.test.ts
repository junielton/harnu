/**
 * inside Electron, `node:fs` treats a `*.asar` file as a directory, so a recursive delete
 * of a tree holding one (every Electron repo's `node_modules/electron/dist/resources/default_app.asar`)
 * leaves the archive behind and ends `ENOTEMPTY`. That halted every Remove at drop-deps.
 *
 * Plain node has no asar patch, so only a real Electron runtime can reproduce it. These tests
 * bundle the production removal helpers with esbuild and run them under the repo's own Electron
 * binary in `ELECTRON_RUN_AS_NODE` mode, which carries the same patched `fs`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const require_ = createRequire(import.meta.url)
const repoRoot = path.resolve(__dirname, '..')
const asarFixture = path.join(repoRoot, 'node_modules/electron/dist/resources/default_app.asar')

let electronBin: string | null = null
try {
  const p = require_('electron') as unknown
  if (typeof p === 'string' && existsSync(p)) electronBin = p
} catch {
  electronBin = null
}
const canRun = electronBin !== null && existsSync(asarFixture)

let tmp: string
let bundle: string

/** Runs `script dir` under Electron-as-node; returns the exit status and what it printed. */
function underElectron(script: string, dir: string): { status: number | null; out: string } {
  const r = spawnSync(electronBin!, [script, dir], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8'
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe.skipIf(!canRun)('recursive removal under Electron (asar patch)', () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-asar-'))
    const entry = path.join(tmp, 'entry.ts')
    bundle = path.join(tmp, 'entry.cjs')
    await fs.writeFile(
      entry,
      `import { removeEphemeralDir } from ${JSON.stringify(
        path.join(repoRoot, 'src/main/reaper/dehydrate-shell.ts')
      )}
removeEphemeralDir(process.argv[2]).then(
  () => console.log('removed'),
  (e) => { console.log('FAILED ' + (e && e.code) + ' ' + (e && e.message)); process.exit(3) }
)
`
    )
    buildSync({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
  })

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('control: node:fs under Electron really cannot remove a tree holding an .asar', async () => {
    const dir = path.join(tmp, 'control', 'node_modules')
    await fs.mkdir(path.join(dir, 'x/y'), { recursive: true })
    await fs.copyFile(asarFixture, path.join(dir, 'x/y/default_app.asar'))
    const script = path.join(tmp, 'control.cjs')
    await fs.writeFile(
      script,
      `require('node:fs').promises.rm(process.argv[2], { recursive: true, force: true })
        .then(() => console.log('removed'), (e) => { console.log('FAILED ' + e.code); process.exit(3) })`
    )
    // If this ever passes, Electron stopped patching fs and the real test below proves nothing.
    expect(underElectron(script, dir).out).toContain('FAILED')
  })

  it('removeEphemeralDir removes a node_modules holding default_app.asar', async () => {
    const dir = path.join(tmp, 'case1', 'node_modules')
    await fs.mkdir(path.join(dir, 'electron/dist/resources'), { recursive: true })
    await fs.copyFile(asarFixture, path.join(dir, 'electron/dist/resources/default_app.asar'))
    await fs.writeFile(path.join(dir, 'electron/index.js'), 'module.exports = 1')

    const r = underElectron(bundle, dir)
    expect(r.out).toContain('removed')
    expect(r.status).toBe(0)
    await expect(fs.lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('no recursive node:fs delete in the Cleanup engine', () => {
  it('every recursive rm under src/main/gc and src/main/reaper goes through rawRm', async () => {
    const offenders: string[] = []
    for (const dir of ['src/main/gc', 'src/main/reaper']) {
      for (const f of await fs.readdir(path.join(repoRoot, dir))) {
        if (!f.endsWith('.ts')) continue
        const text = await fs.readFile(path.join(repoRoot, dir, f), 'utf8')
        text.split('\n').forEach((line, i) => {
          if (/\bfs\.rm\(|\brmSync\(/.test(line) && /recursive:\s*true/.test(line)) {
            offenders.push(`${dir}/${f}:${i + 1}`)
          }
        })
      }
    }
    expect(offenders).toEqual([])
  })
})
