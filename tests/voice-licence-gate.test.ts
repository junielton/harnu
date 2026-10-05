import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  dependencyViolations,
  formatVerdict,
  installedViolations,
  lockfileViolations,
  packageNameFromLockKey,
  scanBufferForMarkers,
  scanTree,
  staticImportViolations,
  voiceLicenceVerdict,
  FORBIDDEN_PACKAGES,
  VENDOR_MARKERS
} from '../scripts/ci/voice-licence-core.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

/**
 * AC-2 — the licence guarantee, and the most important assertion on this card.
 *
 * ADR-0012 option C is only safe while `kokoro-js` and `phonemizer` stay OUT of
 * what Harnu distributes: `phonemizer` inlines a compiled espeak-ng (GPLv3), and
 * shipping it would relicense the packaged binary. The protection is invisible
 * and silently breakable — one `npm i kokoro-js` and it is gone.
 *
 * These tests run the real gate against the real repository, so the guarantee
 * is asserted rather than asserted-about. The build-output half only has
 * something to scan once `npm run build` has run; CI runs the gate after the
 * build with VOICE_LICENCE_REQUIRE_ARTIFACT=1, so "nothing to scan" fails there.
 */
describe('voice licence gate — this repository (AC-2)', () => {
  it('ships no forbidden package, imports none statically, packages none', async () => {
    const verdict = await voiceLicenceVerdict({ repoRoot: REPO })
    expect(verdict.dependencies, formatVerdict(verdict, REPO)).toEqual([])
    expect(verdict.imports, formatVerdict(verdict, REPO)).toEqual([])
    expect(verdict.artifact, formatVerdict(verdict, REPO)).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('has none of them installed under node_modules either', async () => {
    expect(await installedViolations(REPO)).toEqual([])
  })

  it('does scan the build output when one exists', async () => {
    // Not a skip-if-absent hole: when `out/` is there (CI always, locally after
    // a build) the previous test already scanned it. This just makes the fact
    // visible in the report rather than implicit.
    const verdict = await voiceLicenceVerdict({ repoRoot: REPO })
    const built = await fs
      .stat(path.join(REPO, 'out'))
      .then(() => true)
      .catch(() => false)
    expect(verdict.scanned.some((d) => d.endsWith('/out'))).toBe(built)
  })

  it('fails loudly when asked for artifact proof and there is none', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-gate-'))
    try {
      await fs.writeFile(path.join(empty, 'package.json'), '{"name":"x"}')
      const verdict = await voiceLicenceVerdict({ repoRoot: empty, requireArtifact: true })
      expect(verdict.missingArtifact).toBe(true)
      expect(verdict.ok).toBe(false)
      expect(formatVerdict(verdict, empty)).toContain('npm run build')
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })
})

describe('the gate actually catches the thing it exists to catch', () => {
  it('catches a forbidden package added to package.json', () => {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const violations = dependencyViolations({ [field]: { 'kokoro-js': '^1.2.1' } })
      expect(violations).toHaveLength(1)
      expect(violations[0].package).toBe('kokoro-js')
    }
  })

  it('catches phonemizer arriving transitively in the production closure', () => {
    // The realistic failure: nobody adds `phonemizer`; they add `kokoro-js`,
    // which drags it in. That is exactly ADR-0012 option B in disguise.
    const lock = {
      packages: {
        '': { name: 'harnu' },
        'node_modules/kokoro-js': { version: '1.2.1' },
        'node_modules/kokoro-js/node_modules/phonemizer': { version: '1.2.1' }
      }
    }
    expect(
      lockfileViolations(lock)
        .map((v) => v.package)
        .sort()
    ).toEqual(['kokoro-js', 'phonemizer'])
  })

  it('ignores a dev-only lockfile entry, which electron-builder does not pack', () => {
    const lock = { packages: { 'node_modules/kokoro-js': { version: '1.2.1', dev: true } } }
    expect(lockfileViolations(lock)).toEqual([])
  })

  it('reads a scoped package name out of a nested lockfile key', () => {
    expect(packageNameFromLockKey('node_modules/a/node_modules/@huggingface/transformers')).toBe(
      '@huggingface/transformers'
    )
    expect(packageNameFromLockKey('')).toBeNull()
  })

  it('catches the espeak-ng payload in a built file', () => {
    // The emscripten binding name from phonemizer's inlined espeak-ng build.
    // These ARE the GPL bytes; the package name is not.
    const built = Buffer.from('var x=N._emscripten_bind_eSpeakNGWorker_synth__2;')
    expect(scanBufferForMarkers(built)).toContain('eSpeakNGWorker')
  })

  it('catches kokoro-js and transformers payload too', () => {
    expect(scanBufferForMarkers(Buffer.from('async generate_from_ids(e){}'))).toContain(
      'generate_from_ids'
    )
    expect(scanBufferForMarkers(Buffer.from('class StyleTextToSpeech2Model{}'))).toContain(
      'StyleTextToSpeech2Model'
    )
  })

  it('does NOT trip on Harnu naming the packages in its own consent copy', () => {
    // The consent step must state what it downloads and under what licence
    // (AC-4/AC-7), so "kokoro-js" and "phonemizer" are in the build ON PURPOSE.
    // A gate that failed on that would be a gate people learn to disable.
    const ours = Buffer.from(
      'component:"phonemizer@1.2.1",spdx:"Apache-2.0",note:"embeds espeak-ng, GPL-3.0-or-later"'
    )
    expect(scanBufferForMarkers(ours)).toEqual([])
  })

  it('finds a planted payload anywhere under a scanned tree', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-gate-'))
    try {
      await fs.mkdir(path.join(dir, 'main', 'chunks'), { recursive: true })
      await fs.writeFile(path.join(dir, 'main', 'chunks', 'vendor.js'), 'x=eSpeakNGWorker')
      const hits = await scanTree(dir)
      expect(hits).toHaveLength(1)
      expect(hits[0].markers).toEqual(['eSpeakNGWorker'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('reads an .asar as bytes, so the payload cannot hide inside an archive', () => {
    // An asar is a JSON header plus concatenated file contents — greppable
    // without unpacking, which is why the scan is latin1 rather than utf8.
    const asar = Buffer.concat([
      Buffer.from([4, 0, 0, 0]),
      Buffer.from('{"files":{"vendor.js":{"size":20}}}'),
      Buffer.from([0xff, 0xfe, 0x00]),
      Buffer.from('espeakng.worker.data')
    ])
    expect(scanBufferForMarkers(asar)).toContain('espeakng.worker')
  })

  it('catches a static import that would let a bundler pull the package in', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-gate-'))
    try {
      await fs.mkdir(path.join(dir, 'src', 'renderer'), { recursive: true })
      await fs.writeFile(
        path.join(dir, 'src', 'renderer', 'bad.ts'),
        "import { KokoroTTS } from 'kokoro-js'\n"
      )
      const violations = await staticImportViolations(dir)
      expect(violations).toHaveLength(1)
      expect(violations[0].package).toBe('kokoro-js')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('allows the runtime import of a userData url, which is the whole design', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-gate-'))
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true })
      await fs.writeFile(
        path.join(dir, 'src', 'ok.ts'),
        'export const load = (url: string) => import(/* @vite-ignore */ url)\n'
      )
      expect(await staticImportViolations(dir)).toEqual([])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('explains the failure in terms of the licence, not the regex', () => {
    const verdict = {
      ok: false,
      dependencies: [{ where: 'package.json dependencies', package: 'kokoro-js' }],
      imports: [],
      artifact: [{ file: '/repo/out/main/index.js', markers: ['eSpeakNGWorker'] }],
      scanned: [],
      missingArtifact: false
    }
    const text = formatVerdict(verdict, '/repo')
    expect(text).toContain('espeak-ng')
    expect(text).toContain('GPL')
    expect(text).toContain('docs/adr/0012')
  })
})

describe('the gate covers the packages that matter', () => {
  it('names kokoro-js and phonemizer explicitly (the two AC-2 calls out)', () => {
    expect(FORBIDDEN_PACKAGES).toContain('kokoro-js')
    expect(FORBIDDEN_PACKAGES).toContain('phonemizer')
  })

  it('has at least one marker per forbidden runtime package it can detect', () => {
    for (const pkg of ['kokoro-js', 'phonemizer', '@huggingface/transformers']) {
      expect(VENDOR_MARKERS.some((m) => m.package === pkg)).toBe(true)
    }
  })

  it('uses no marker that appears in Harnu source (it would fail every build)', async () => {
    const dir = path.join(REPO, 'src')
    const files: string[] = []
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) await walk(full)
        else if (/\.(ts|vue|json)$/.test(e.name)) files.push(full)
      }
    }
    await walk(dir)
    const sources = await Promise.all(files.map((f) => fs.readFile(f, 'utf8')))
    const blob = sources.join('\n')
    for (const { marker } of VENDOR_MARKERS) {
      expect(blob.includes(marker), `marker ${marker} appears in src/`).toBe(false)
    }
  })
})
