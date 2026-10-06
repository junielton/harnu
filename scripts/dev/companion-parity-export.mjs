#!/usr/bin/env node
/**
 * Exports a scrubbed parity trace for replay (T389 P1W4 §7.5).
 *
 *   node scripts/dev/companion-parity-export.mjs --user-data <dir> --stream <name> [--name <file>] [--max <n>]
 *
 * Reads `<dir>/companion/parity/<stream>*.ndjson`, keeps only the fields of a ledger record,
 * drops any detail key or value that could name a path, a prompt, a token or a connection, and
 * writes `tests/fixtures/companion-parity/<stream>/<file>.ndjson` (oldest first). The ledger
 * already scrubs on the way in; this is a second pass, because a committed fixture is public.
 * Nothing is written when a record still looks like it carries one of those after the pass.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIELDS = [
  'v',
  'stream',
  'source',
  'owner',
  'reason',
  'disposition',
  'sk',
  't',
  'ts',
  'k',
  'd',
  'cli',
  'mod'
]
const DENIED_KEY =
  /(path|file|prompt|text|conn|token|spawn|cwd|dir|input|command|message|secret|auth|sid|session|body|url|env)/i
const SAFE_VALUE = /^[A-Za-z0-9_.:+-]{0,48}$/
const SECRET_SHAPE = /^(c|sp|b|tok|key)_[0-9a-f-]{12,}$/i

export function scrubRecord(raw) {
  if (!raw || raw.v !== 1 || typeof raw.stream !== 'string') return null
  const out = {}
  for (const f of FIELDS) if (raw[f] !== undefined) out[f] = raw[f]
  if (out.d && typeof out.d === 'object') {
    const d = {}
    for (const [key, value] of Object.entries(out.d)) {
      if (DENIED_KEY.test(key)) continue
      if (value === null || typeof value === 'boolean' || Number.isFinite(value)) d[key] = value
      else if (typeof value === 'string' && SAFE_VALUE.test(value) && !SECRET_SHAPE.test(value))
        d[key] = value
    }
    if (Object.keys(d).length > 0) out.d = d
    else delete out.d
  }
  const line = JSON.stringify(out)
  if (/[/\\]|c_[0-9a-f]{16}|sp_[0-9a-f-]{12}/i.test(line)) return null
  return out
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args['user-data'] || !args.stream) {
    console.error(
      'usage: companion-parity-export --user-data <dir> --stream <name> [--name <file>] [--max <n>]'
    )
    process.exit(2)
  }
  const stream = args.stream
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(stream)) {
    console.error('invalid stream name')
    process.exit(2)
  }
  const parityDir = join(resolve(args['user-data']), 'companion', 'parity')
  // oldest generation first: `<stream>.2`, `<stream>.1`, `<stream>`
  const files = readdirSync(parityDir)
    .filter((n) => n === `${stream}.ndjson` || new RegExp(`^${stream}\\.\\d+\\.ndjson$`).test(n))
    .sort((a, b) => (b.match(/\.(\d+)\./)?.[1] ?? '0') - (a.match(/\.(\d+)\./)?.[1] ?? '0'))
  const records = []
  let refused = 0
  for (const name of files) {
    for (const line of readFileSync(join(parityDir, name), 'utf8').split('\n')) {
      if (!line) continue
      try {
        const rec = scrubRecord(JSON.parse(line))
        if (rec) records.push(rec)
        else refused++
      } catch {
        refused++
      }
    }
  }
  const max = args.max ? Number(args.max) : records.length
  const kept = records.slice(-max)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const outDir = join(root, 'tests', 'fixtures', 'companion-parity', stream)
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `${args.name ?? 'export'}.ndjson`)
  writeFileSync(outFile, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''))
  console.log(`${kept.length} records written to ${outFile} (${refused} refused)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
