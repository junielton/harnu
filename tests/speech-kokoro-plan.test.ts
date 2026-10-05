import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import {
  applyKokoroRewrites,
  buildInstallManifest,
  abortCleanupTargets,
  cdnUrlFor,
  crawlWithinBudget,
  extractEsmImports,
  isKokoroVoiceId,
  kokoroContentType,
  kokoroInstallPlan,
  kokoroModelAssets,
  kokoroRuntimeAssets,
  kokoroRuntimeConfig,
  kokoroVoiceAssets,
  missingVoices,
  parseInstallManifest,
  progressFraction,
  rangeHeader,
  resolveKokoroAssetPath,
  resumeDecision,
  KokoroRewriteError,
  KOKORO_CODE_MAX_BYTES,
  KOKORO_CODE_MAX_FILES,
  KOKORO_ENTRY_PATH,
  KOKORO_LICENCES,
  KOKORO_ORIGIN,
  KOKORO_PIN,
  KOKORO_REWRITES
} from '../src/main/speech-kokoro-plan'

describe('kokoroInstallPlan', () => {
  it('states what a consent step has to state: size, contents, terms (AC-4)', () => {
    const plan = kokoroInstallPlan(['af_heart'])
    expect(plan.totalBytes).toBe(plan.exactBytes + plan.approxBytes)
    // The honest number: ~22 MB of ONNX runtime + 92.4 MB of weights + a voice
    // + the code tier. Anything an order of magnitude off means the manifest
    // drifted from the sizes verified against upstream.
    expect(plan.totalBytes).toBeGreaterThan(110_000_000)
    expect(plan.totalBytes).toBeLessThan(130_000_000)
    expect(plan.licences.length).toBeGreaterThan(0)
    expect(plan.codeSeed).toBe(KOKORO_ENTRY_PATH)
  })

  it('fetches the CODE as well as the weights — the whole point of option C', () => {
    const plan = kokoroInstallPlan([])
    // The code tier is crawled, so it is the seed rather than a listed asset:
    // if this ever became "weights only", ADR-0012 option B would be back.
    expect(plan.codeSeed).toContain('kokoro-js')
    expect(plan.assets.some((a) => a.kind === 'model')).toBe(true)
    expect(plan.assets.some((a) => a.kind === 'runtime')).toBe(true)
  })

  it('names phonemizer AND its GPL reality in the attribution (AC-7)', () => {
    const phonemizer = KOKORO_LICENCES.find((l) => l.component.startsWith('phonemizer'))
    expect(phonemizer).toBeDefined()
    expect(phonemizer?.spdx).toBe('Apache-2.0')
    // The declared licence is not the whole truth, and the consent step has to
    // say so — that mismatch is the entire subject of ADR-0012.
    expect(phonemizer?.note).toMatch(/espeak-ng/i)
    expect(phonemizer?.note).toMatch(/GPL/i)
  })

  it('attributes kokoro-js and the weights as Apache-2.0 (AC-7)', () => {
    const kokoro = KOKORO_LICENCES.find((l) => l.component.startsWith('kokoro-js'))
    const model = KOKORO_LICENCES.find((l) => l.component === KOKORO_PIN.modelId)
    expect(kokoro?.spdx).toBe('Apache-2.0')
    expect(model?.spdx).toBe('Apache-2.0')
  })

  it('defaults to one voice rather than downloading the whole catalog', () => {
    const plan = kokoroInstallPlan([])
    expect(plan.voices).toEqual([KOKORO_PIN.defaultVoice])
    expect(plan.assets.filter((a) => a.kind === 'voice')).toHaveLength(1)
  })

  it('dedupes and rejects bogus voice ids', () => {
    const plan = kokoroInstallPlan(['af_heart', 'af_heart', '../../etc/passwd', 'bm_george'])
    expect(plan.voices).toEqual(['af_heart', 'bm_george'])
  })

  it('uses the q8 weights, not the 326 MB fp32 ones', () => {
    const model = kokoroModelAssets().find((a) => a.kind === 'model')
    expect(model?.path).toContain('model_quantized.onnx')
    expect(model?.bytes).toBe(92_361_116)
  })

  it('mirrors the ONNX runtime so the first utterance offline is not a network call', () => {
    const runtime = kokoroRuntimeAssets()
    expect(runtime.map((a) => a.path.split('/').pop())).toEqual([
      'ort-wasm-simd-threaded.jsep.mjs',
      'ort-wasm-simd-threaded.jsep.wasm'
    ])
    expect(runtime.every((a) => (a.bytes ?? 0) > 0)).toBe(true)
  })

  it('gives every voice the same fixed size', () => {
    const voices = kokoroVoiceAssets(['af_heart', 'bm_george'])
    expect(voices.map((v) => v.bytes)).toEqual([522_240, 522_240])
  })
})

describe('isKokoroVoiceId', () => {
  it('accepts the upstream shape', () => {
    expect(isKokoroVoiceId('af_heart')).toBe(true)
    expect(isKokoroVoiceId('bm_george')).toBe(true)
  })

  it('rejects anything that could escape the voices directory', () => {
    for (const bad of ['../x', 'af_heart/../..', 'af heart', 'AF_HEART', '', null, 42]) {
      expect(isKokoroVoiceId(bad)).toBe(false)
    }
  })
})

describe('extractEsmImports', () => {
  it('finds the root-relative imports a /+esm bundle actually has', () => {
    const src = 'import{a}from"/npm/phonemizer@1.2.1/+esm";export{a};'
    expect(extractEsmImports(src)).toEqual(['/npm/phonemizer@1.2.1/+esm'])
  })

  it('ignores a /npm/ lookalike buried in an unrelated string literal', () => {
    // Minified onnxruntime contains strings that a naive scan reads as imports;
    // this is why the pattern is anchored on `from`/`import` AND the prefix.
    const src = 'const msg="see /npm/not-a-module/+esm for details";'
    expect(extractEsmImports(src)).toEqual([])
  })

  it('dedupes and handles dynamic imports and single quotes', () => {
    const src = `import"/npm/a/+esm";import('/npm/a/+esm');const x=await import("/npm/b/+esm")`
    expect(extractEsmImports(src)).toEqual(['/npm/a/+esm', '/npm/b/+esm'])
  })

  it('builds the CDN url for a mirror path', () => {
    expect(cdnUrlFor('/npm/x/+esm')).toBe('https://cdn.jsdelivr.net/npm/x/+esm')
  })
})

describe('crawlWithinBudget', () => {
  it('allows the real graph (5 files, ~2.2 MB)', () => {
    expect(crawlWithinBudget({ files: 5, bytes: 2_300_000 })).toBe(true)
  })

  it('refuses an upstream restructure that explodes the graph', () => {
    expect(crawlWithinBudget({ files: KOKORO_CODE_MAX_FILES + 1, bytes: 1 })).toBe(false)
    expect(crawlWithinBudget({ files: 1, bytes: KOKORO_CODE_MAX_BYTES + 1 })).toBe(false)
  })
})

describe('applyKokoroRewrites', () => {
  const rule = KOKORO_REWRITES[0]!

  it('points the hardcoded huggingface.co voice url at the local mirror', () => {
    const src = `const a=\`${rule.find}\${e}.bin\`;`
    const out = applyKokoroRewrites(KOKORO_ENTRY_PATH, src)
    expect(out).not.toContain('https://huggingface.co')
    expect(out).toContain(KOKORO_ORIGIN)
  })

  it('refuses the install when upstream changed the string (never a silent no-op)', () => {
    // A rewrite that matches nothing would install cleanly and then fail to
    // speak offline months later. Failing here is the cheaper failure.
    expect(() => applyKokoroRewrites(KOKORO_ENTRY_PATH, 'const a="something else";')).toThrow(
      KokoroRewriteError
    )
  })

  it('refuses when the string appears more times than declared', () => {
    const src = `${rule.find}${rule.find}`
    expect(() => applyKokoroRewrites(KOKORO_ENTRY_PATH, src)).toThrow(KokoroRewriteError)
  })

  it('leaves files with no rule untouched', () => {
    const src = 'export const x=1'
    expect(applyKokoroRewrites('/npm/phonemizer@1.2.1/+esm', src)).toBe(src)
  })
})

describe('resolveKokoroAssetPath', () => {
  const root = '/home/u/.config/Harnu/voice-kokoro'
  const join = path.posix.join

  it('serves the mirrored module graph', () => {
    expect(resolveKokoroAssetPath(root, '/npm/kokoro-js@1.2.1/+esm', join)).toBe(
      `${root}/npm/kokoro-js@1.2.1/+esm`
    )
  })

  it('serves the mirrored model files', () => {
    expect(
      resolveKokoroAssetPath(root, '/hf/onnx-community/Kokoro-82M-v1.0-ONNX/config.json', join)
    ).toBe(`${root}/hf/onnx-community/Kokoro-82M-v1.0-ONNX/config.json`)
  })

  it('decodes percent-encoding before deciding, not after', () => {
    // `%2e%2e` is `..`; a check that ran on the raw string would wave it through.
    expect(resolveKokoroAssetPath(root, '/npm/%2e%2e/%2e%2e/secrets', join)).toBeNull()
  })

  it('refuses traversal, NUL, backslashes and unknown roots', () => {
    for (const bad of [
      '/npm/../../../etc/passwd',
      '/npm/./x',
      '/../etc/passwd',
      '/etc/passwd',
      '/npm/x\0.js',
      '/npm/..\\windows',
      '/npm',
      'npm/x',
      ''
    ]) {
      expect(resolveKokoroAssetPath(root, bad, join)).toBeNull()
    }
  })

  it('refuses when there is no install root', () => {
    expect(resolveKokoroAssetPath('', '/npm/x/+esm', join)).toBeNull()
  })
})

describe('kokoroContentType', () => {
  it('serves the extensionless /+esm files as javascript', () => {
    expect(kokoroContentType('/npm/kokoro-js@1.2.1/+esm')).toBe('text/javascript')
  })

  it('serves wasm as application/wasm so streaming instantiation works', () => {
    expect(kokoroContentType('/npm/x/dist/ort.wasm')).toBe('application/wasm')
  })

  it('covers the rest', () => {
    expect(kokoroContentType('/npm/x/y.mjs')).toBe('text/javascript')
    expect(kokoroContentType('/hf/m/config.json')).toBe('application/json')
    expect(kokoroContentType('/hf/m/voices/af_heart.bin')).toBe('application/octet-stream')
  })
})

describe('resumeDecision (AC-5)', () => {
  it('starts fresh when nothing is on disk', () => {
    expect(resumeDecision(0, 100)).toEqual({ mode: 'fresh', offset: 0 })
  })

  it('resumes an interrupted download from where it stopped', () => {
    expect(resumeDecision(40, 100)).toEqual({ mode: 'range', offset: 40 })
    expect(rangeHeader(40)).toBe('bytes=40-')
  })

  it('needs no request when the partial is already complete', () => {
    expect(resumeDecision(100, 100)).toEqual({ mode: 'done', offset: 100 })
  })

  it('restarts rather than resume into a corrupt or stale partial', () => {
    expect(resumeDecision(140, 100).mode).toBe('fresh')
  })

  it('restarts when the size is unknown — a range would be unverifiable', () => {
    expect(resumeDecision(40, null).mode).toBe('fresh')
  })
})

describe('abortCleanupTargets (AC-5)', () => {
  it('removes everything when a first install is cancelled', () => {
    // "no partial file and no half-installed module": a half-populated mirror
    // is the half-installed module.
    expect(abortCleanupTargets('cancel', false)).toEqual(['root'])
  })

  it('removes only staging when adding to a working install', () => {
    // Cancelling an extra voice must never destroy the voice already there.
    expect(abortCleanupTargets('cancel', true)).toEqual(['staging'])
  })

  it('deletes NOTHING on a quit — closing the app is not discarding 92 MB', () => {
    expect(abortCleanupTargets('quit', false)).toEqual([])
    expect(abortCleanupTargets('quit', true)).toEqual([])
  })

  it('deletes nothing on a failure either, so the next attempt resumes', () => {
    // A network drop at 80 MB must not cost the operator those 80 MB.
    expect(abortCleanupTargets('failure', false)).toEqual([])
    expect(abortCleanupTargets('failure', true)).toEqual([])
  })
})

describe('install manifest', () => {
  const now = new Date('2026-09-03T10:00:00.000Z')

  it('round-trips', () => {
    const built = buildInstallManifest(['af_heart'], 119_000_000, now)
    expect(parseInstallManifest(JSON.stringify(built))).toEqual(built)
  })

  it('reads an absent or unparsable manifest as not installed', () => {
    expect(parseInstallManifest(null)).toBeNull()
    expect(parseInstallManifest('')).toBeNull()
    expect(parseInstallManifest('{')).toBeNull()
    expect(parseInstallManifest('[]')).toBeNull()
    expect(parseInstallManifest('"x"')).toBeNull()
  })

  it('reads a manifest pinned to other upstream versions as not installed', () => {
    // The mirror on disk would not match the module URLs this build imports.
    const stale = { ...buildInstallManifest(['af_heart'], 1, now), kokoro: '1.1.0' }
    expect(parseInstallManifest(JSON.stringify(stale))).toBeNull()
    const otherLayout = { ...buildInstallManifest(['af_heart'], 1, now), version: 99 }
    expect(parseInstallManifest(JSON.stringify(otherLayout))).toBeNull()
    const otherModel = { ...buildInstallManifest(['af_heart'], 1, now), modelId: 'x/y' }
    expect(parseInstallManifest(JSON.stringify(otherModel))).toBeNull()
  })

  it('reads a manifest with no usable voice as not installed', () => {
    const empty = { ...buildInstallManifest(['af_heart'], 1, now), voices: ['../evil'] }
    expect(parseInstallManifest(JSON.stringify(empty))).toBeNull()
  })

  it('reports only the voices still missing', () => {
    const manifest = buildInstallManifest(['af_heart'], 1, now)
    expect(missingVoices(manifest, ['af_heart'])).toEqual([])
    expect(missingVoices(manifest, ['af_heart', 'bm_george'])).toEqual(['bm_george'])
    expect(missingVoices(null, ['bm_george'])).toEqual(['bm_george'])
  })
})

describe('kokoroRuntimeConfig', () => {
  it('keeps every url on the mirror — nothing points at the network', () => {
    const cfg = kokoroRuntimeConfig()
    for (const url of [cfg.entryUrl, cfg.transformersUrl, cfg.wasmPaths, cfg.remoteHost]) {
      expect(url.startsWith(KOKORO_ORIGIN)).toBe(true)
      expect(url).not.toContain('huggingface.co')
      expect(url).not.toContain('jsdelivr')
    }
  })

  it('asks for the q8 weights', () => {
    expect(kokoroRuntimeConfig().dtype).toBe('q8')
  })
})

describe('progressFraction', () => {
  it('is 0 before a total is known, and clamps', () => {
    expect(progressFraction(0, 0)).toBe(0)
    expect(progressFraction(10, 0)).toBe(0)
    expect(progressFraction(150, 100)).toBe(1)
    expect(progressFraction(50, 100)).toBe(0.5)
    expect(progressFraction(Number.NaN, 100)).toBe(0)
  })
})
