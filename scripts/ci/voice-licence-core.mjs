// Pure core of the voice licence gate (T241, ADR-0012 option C).
//
// THE CLAIM THIS FILE MAKES MECHANICAL
// ------------------------------------
// Harnu is MIT and ships a packaged Electron binary. The offline voice needs
// `kokoro-js`, which is Apache-2.0 — but its dependency `phonemizer` inlines a
// compiled espeak-ng, and espeak-ng is GPL-3.0-or-later. Redistributing those
// bytes inside the .AppImage / .deb / .dmg / .exe would relicense the whole
// shipped artifact as GPLv3 (ADR-0012 §3-4).
//
// ADR-0012 option C avoids that by fetching the CODE as well as the weights at
// runtime, into the operator's own userData. That protection is invisible: it
// holds only as long as nobody adds `kokoro-js` to package.json "to make the
// types work", and it fails silently if they do. This gate is the alarm.
//
// It asserts three independent things, because any one alone can be fooled:
//
//   A. DEPENDENCIES — no forbidden package in package.json, in the production
//      closure of package-lock.json, or installed under node_modules/. This is
//      the actual licence question: electron-builder packs the production
//      dependency tree, so a package listed here IS a package we redistribute.
//
//   B. THE BUILT ARTIFACT — no vendor payload in `out/**` (what electron-vite
//      produces and electron-builder packs) or in any `app.asar` under `dist/`.
//      This is the "assert against the built artifact, not the source tree"
//      half of AC-2.
//
//   C. STATIC IMPORTS — nothing under src/ imports these modules statically.
//      A bundler resolves a static import at build time; only the runtime
//      `import(<userData url>)` in speech-kokoro.ts is allowed.
//
// WHY IT LOOKS FOR SYMBOLS, NOT PACKAGE NAMES
// -------------------------------------------
// Harnu's own source legitimately contains the strings "kokoro-js" and
// "phonemizer" — the consent step has to name what it is downloading and under
// what licence (AC-4/AC-7), so those literals are in the build ON PURPOSE.
// Grepping for the names would therefore fail on a correct build, which is the
// worst kind of gate: one people learn to ignore.
//
// So part B looks for symbols that exist only inside the real packages and
// appear nowhere in Harnu's source — the emscripten binding names of the
// espeak-ng build, and the exported members of kokoro-js / transformers.js.
// Each survives minification (they are property names, export names, or string
// literals), and each was verified present upstream and absent from src/ when
// this gate was written.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** Packages whose presence in the shipped dependency tree is the violation. */
export const FORBIDDEN_PACKAGES = Object.freeze([
  'kokoro-js',
  'phonemizer',
  '@huggingface/transformers',
  'onnxruntime-web',
  'onnxruntime-common',
  'onnxruntime-node'
])

/**
 * Symbols that exist only inside the vendored packages. `why` is printed on a
 * failure so whoever hits this understands what actually leaked.
 */
export const VENDOR_MARKERS = Object.freeze([
  {
    marker: 'eSpeakNGWorker',
    package: 'phonemizer',
    why: 'emscripten binding name of the compiled espeak-ng (GPL-3.0-or-later)'
  },
  {
    marker: 'espeakng.worker',
    package: 'phonemizer',
    why: "espeak-ng's packaged data file, embedded in phonemizer's bundle"
  },
  {
    marker: 'generate_from_ids',
    package: 'kokoro-js',
    why: 'KokoroTTS method, present only in the real kokoro-js bundle'
  },
  {
    marker: 'TextSplitterStream',
    package: 'kokoro-js',
    why: 'kokoro-js export, present only in the real bundle'
  },
  {
    marker: 'StyleTextToSpeech2Model',
    package: '@huggingface/transformers',
    why: 'transformers.js model class kokoro-js instantiates'
  }
])

/** Extensions worth reading as text. Everything else is scanned as bytes anyway. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache'])

// ---------------------------------------------------------------------------
// A. Dependencies
// ---------------------------------------------------------------------------

const MANIFEST_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]

/**
 * Forbidden packages named anywhere in package.json.
 *
 * devDependencies count too. electron-builder does not pack them, so this is
 * stricter than the licence strictly requires — deliberately: a devDependency
 * is one `--omit` flag away from being a runtime one, and "we had it in dev"
 * is how the bundle-the-library mistake gets made in the first place.
 */
export function dependencyViolations(pkgJson) {
  const out = []
  if (!pkgJson || typeof pkgJson !== 'object') return out
  for (const field of MANIFEST_FIELDS) {
    const block = pkgJson[field]
    if (!block || typeof block !== 'object') continue
    for (const name of Object.keys(block)) {
      if (FORBIDDEN_PACKAGES.includes(name)) {
        out.push({ where: `package.json ${field}`, package: name })
      }
    }
  }
  return out
}

/** Package name out of a lockfile v2/v3 key like `node_modules/a/node_modules/b`. */
export function packageNameFromLockKey(key) {
  const idx = key.lastIndexOf('node_modules/')
  if (idx === -1) return null
  const name = key.slice(idx + 'node_modules/'.length)
  return name.length > 0 ? name : null
}

/**
 * Forbidden packages in the PRODUCTION closure of the lockfile — the tree
 * electron-builder actually packs. `dev: true` entries are reported separately
 * by {@link dependencyViolations} and skipped here, so the two checks stay
 * about different things.
 */
export function lockfileViolations(lockJson) {
  const out = []
  const packages = lockJson?.packages
  if (!packages || typeof packages !== 'object') return out
  for (const [key, entry] of Object.entries(packages)) {
    if (!key || entry?.dev === true) continue
    const name = packageNameFromLockKey(key)
    if (name && FORBIDDEN_PACKAGES.includes(name)) {
      out.push({ where: `package-lock.json (production closure) ${key}`, package: name })
    }
  }
  return out
}

/** Forbidden packages actually installed on disk. */
export async function installedViolations(repoRoot) {
  const out = []
  for (const name of FORBIDDEN_PACKAGES) {
    const dir = path.join(repoRoot, 'node_modules', ...name.split('/'))
    try {
      const stat = await fs.stat(dir)
      if (stat.isDirectory()) out.push({ where: `node_modules/${name}`, package: name })
    } catch {
      // Absent is the whole point.
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// B. The built artifact
// ---------------------------------------------------------------------------

/**
 * Markers found in a buffer. Reads as latin1 so an `.asar` — a JSON header
 * followed by concatenated file bytes — is searchable without unpacking it,
 * and so invalid UTF-8 in a binary never truncates the scan.
 */
export function scanBufferForMarkers(buffer) {
  const text = buffer.toString('latin1')
  return VENDOR_MARKERS.filter((m) => text.includes(m.marker)).map((m) => m.marker)
}

async function walk(dir, onFile) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(full, onFile)
    } else if (entry.isFile()) {
      await onFile(full)
    }
  }
}

/** Every file under `root` that carries a vendor marker. */
export async function scanTree(root) {
  const hits = []
  await walk(root, async (file) => {
    const markers = scanBufferForMarkers(await fs.readFile(file))
    if (markers.length > 0) hits.push({ file, markers })
  })
  return hits
}

/** Build outputs to scan, in the order they appear once a build has run. */
export async function artifactRoots(repoRoot) {
  const roots = []
  for (const candidate of ['out', 'dist']) {
    const dir = path.join(repoRoot, candidate)
    try {
      if ((await fs.stat(dir)).isDirectory()) roots.push(dir)
    } catch {
      // Not built in this checkout — the caller decides whether that is fatal.
    }
  }
  return roots
}

// ---------------------------------------------------------------------------
// C. Static imports
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g

/** Forbidden packages imported statically anywhere under `src/`. */
export async function staticImportViolations(repoRoot) {
  const out = []
  await walk(path.join(repoRoot, 'src'), async (file) => {
    if (!/\.(ts|tsx|js|mjs|cjs|vue)$/.test(file)) return
    const source = await fs.readFile(file, 'utf8')
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1]
      const pkg = FORBIDDEN_PACKAGES.find((p) => spec === p || spec.startsWith(`${p}/`))
      if (pkg) out.push({ where: path.relative(repoRoot, file), package: pkg })
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Run every check. `requireArtifact` makes a missing build a failure — CI runs
 * this after `npm run build`, where "there was nothing to scan" must not pass
 * as "nothing was found".
 */
export async function voiceLicenceVerdict({ repoRoot, requireArtifact = false } = {}) {
  const root = repoRoot ?? process.cwd()
  const pkgJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  let lockJson = null
  try {
    lockJson = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'))
  } catch {
    lockJson = null
  }

  const dependencies = [
    ...dependencyViolations(pkgJson),
    ...lockfileViolations(lockJson),
    ...(await installedViolations(root))
  ]
  const imports = await staticImportViolations(root)
  const roots = await artifactRoots(root)
  const artifact = []
  for (const dir of roots) artifact.push(...(await scanTree(dir)))

  const missingArtifact = requireArtifact && roots.length === 0
  return {
    ok:
      dependencies.length === 0 &&
      imports.length === 0 &&
      artifact.length === 0 &&
      !missingArtifact,
    dependencies,
    imports,
    artifact,
    scanned: roots,
    missingArtifact
  }
}

export function formatVerdict(verdict, repoRoot = process.cwd()) {
  if (verdict.ok) {
    const where = verdict.scanned.map((d) => path.relative(repoRoot, d) || '.').join(', ')
    return (
      '✓ voice licence gate: no kokoro-js / phonemizer / transformers payload in the ' +
      `dependency tree${where ? ` or in the built artifact (${where})` : ''}. ` +
      'ADR-0012 option C holds — the shipped binary stays MIT.'
    )
  }
  const lines = ['✗ voice licence gate FAILED — ADR-0012 option C is broken.', '']
  if (verdict.missingArtifact) {
    lines.push(
      'No build output found (out/ or dist/). Run `npm run build` first — an',
      'unbuilt tree cannot prove anything about the packaged artifact.',
      ''
    )
  }
  for (const v of verdict.dependencies) {
    lines.push(`  dependency  ${v.package}  ←  ${v.where}`)
  }
  for (const v of verdict.imports) {
    lines.push(`  static import of ${v.package} in ${v.where}`)
  }
  for (const hit of verdict.artifact) {
    const why = hit.markers
      .map((m) => VENDOR_MARKERS.find((x) => x.marker === m))
      .filter(Boolean)
      .map((m) => `${m.marker} (${m.package}: ${m.why})`)
    lines.push(`  packaged    ${path.relative(repoRoot, hit.file)}`)
    for (const w of why) lines.push(`                ${w}`)
  }
  lines.push(
    '',
    'These packages must never ship inside Harnu: `phonemizer` inlines a compiled',
    'espeak-ng (GPL-3.0-or-later), and distributing it would relicense the whole',
    'packaged binary as GPLv3. They are fetched at RUNTIME into userData instead —',
    'see docs/adr/0012 and src/main/speech-kokoro-plan.ts.'
  )
  return lines.join('\n')
}
