import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderSecretRules } from '../../scripts/ci/render-secret-rules.mjs'
import { createStager } from '../../src/main/companion/staging'

/**
 * T455 W1 AC-2, drift: the wire redaction's rules live ONCE, in `resources/companion/
 * secret-rules.json`, and every mod that stages them carries the same generated
 * `hooks/lib/secret-rules.gen.ts`, byte for byte (spec §5.5 rule 2, "Drift").
 */

const RESOURCES = resolve(import.meta.dirname, '..', '..', 'resources')
const COMPANION = join(RESOURCES, 'companion')
const GEN = join('hooks', 'lib', 'secret-rules.gen.ts')

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const source = async (): Promise<unknown> =>
  JSON.parse(await readFile(join(COMPANION, 'secret-rules.json'), 'utf8'))

describe('secret rules: one source, byte-identical staged copies', () => {
  it('the committed module is exactly what the generator renders from the source', async () => {
    const committed = await readFile(join(COMPANION, GEN), 'utf8')
    expect(committed).toBe(renderSecretRules(await source()))
  })

  it('every mod under resources/ that carries the module carries the same bytes', async () => {
    const want = await readFile(join(COMPANION, GEN))
    let copies = 0
    for (const e of await readdir(RESOURCES, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = join(RESOURCES, e.name, GEN)
      const got = await readFile(p).catch(() => null)
      if (got === null) continue
      copies++
      expect(got.equals(want), p).toBe(true)
    }
    expect(copies).toBeGreaterThanOrEqual(1)
  })

  it('the host staging copies it into the staged plugin byte for byte', async () => {
    const work = await mkdtemp(join(tmpdir(), 'harnu-rules-'))
    dirs.push(work)
    const userData = join(work, 'userData')
    const src = join(work, 'resources-companion')
    await mkdir(userData, { recursive: true })
    await cp(COMPANION, src, {
      recursive: true,
      filter: (p) => !/\.claude-plugin[\\/]types|coords\.gen\.ts|\.dev-lock/.test(p)
    })
    const dir = await createStager({
      userData,
      resourceDir: src,
      isPackaged: false,
      devFlag: false,
      now: () => 1_790_000_000_000,
      pid: 4242,
      isPidAlive: () => false,
      log: () => {}
    }).ensureStaged()
    expect(dir).not.toBeNull()
    const staged = await readFile(join(dir!, GEN))
    expect(staged.equals(await readFile(join(COMPANION, GEN)))).toBe(true)
    // the source itself is not shipped: only `hooks/`, `types/` and the manifest are staged
    await expect(readFile(join(dir!, 'secret-rules.json'))).rejects.toThrow()
  })

  it('the module records the T450 commit it was copied from', async () => {
    const committed = await readFile(join(COMPANION, GEN), 'utf8')
    expect(committed).toMatch(/7bfb3e7259bb339324f3faf2a0a85303a558f8ed/)
  })

  it('the module is plain data: no import, no function, no RegExp literal', async () => {
    const committed = await readFile(join(COMPANION, GEN), 'utf8')
    const code = committed.replace(/^\s*\/\/.*$/gm, '').replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    expect(code).not.toMatch(/\bimport\b|\brequire\s*\(|=>|\bfunction\b/)
    expect(code).not.toMatch(/(^|[=(,:\s])\/[^/\n*]/m)
  })
})
