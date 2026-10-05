import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { migrateDataDir, MIGRATED_MARKER_PREFIX } from '../src/main/migrations/data-dir'

/**
 * U8 AC-5 / U9 AC-9 — dry run on REAL data, with the production defaults (armed). Opt-in: set `HARNU_DRYRUN_SOURCE` to a data dir to
 * rehearse on (it is `cp -a`'d into a throwaway git repo first and never opened
 * for writing). `HARNU_DRYRUN_REPORT` names a file the measured summary is written to.
 */
const SOURCE = process.env.HARNU_DRYRUN_SOURCE
const REPORT = process.env.HARNU_DRYRUN_REPORT

interface Entry {
  rel: string
  kind: 'file' | 'dir' | 'symlink'
  size: number
  sha: string
  mtimeMs: number
}

function snapshot(root: string): Entry[] {
  const out: Entry[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const st = lstatSync(p)
      const rel = relative(root, p)
      if (st.isDirectory()) {
        out.push({ rel, kind: 'dir', size: 0, sha: '', mtimeMs: st.mtimeMs })
        walk(p)
      } else if (st.isSymbolicLink()) {
        out.push({
          rel,
          kind: 'symlink',
          size: 0,
          sha: readlinkSync(p),
          mtimeMs: st.mtimeMs
        })
      } else {
        out.push({
          rel,
          kind: 'file',
          size: st.size,
          sha: createHash('sha256').update(readFileSync(p)).digest('hex'),
          mtimeMs: st.mtimeMs
        })
      }
    }
  }
  walk(root)
  return out
}

describe.skipIf(!SOURCE || !existsSync(SOURCE ?? ''))(
  'data-dir copy — dry run on real data',
  () => {
    it('copies a real data dir losslessly and leaves the original byte-identical', async () => {
      const repo = mkdtempSync(join(tmpdir(), 'harnu-dryrun-'))
      try {
        execFileSync('git', ['init', '-q', repo])
        execFileSync('cp', ['-a', SOURCE as string, join(repo, '.capy')])

        const before = snapshot(join(repo, '.capy'))
        const res = await migrateDataDir(repo, { appVersion: 'dry-run' })
        const after = snapshot(join(repo, '.capy'))
        const copy = snapshot(join(repo, '.harnu'))

        expect(res.outcome).toBe('copied')
        // The original: same entries, hashes and mtimes, before and after.
        expect(after).toEqual(before)

        const marker = `${MIGRATED_MARKER_PREFIX}capy`
        // The default canvas board is renamed inside the copy (so the app opens it).
        const renamed = (rel: string): string =>
          rel === 'out/canvas/board.capycanvas.json' &&
          !before.some((e) => e.rel === 'out/canvas/board.harnucanvas.json')
            ? 'out/canvas/board.harnucanvas.json'
            : rel
        const orig = new Map(before.map((e) => [renamed(e.rel), { ...e, rel: renamed(e.rel) }]))
        const copied = new Map(copy.filter((e) => e.rel !== marker).map((e) => [e.rel, e]))
        expect([...copied.keys()].sort()).toEqual([...orig.keys()].sort())

        const changed: string[] = []
        for (const [rel, o] of orig) {
          const c = copied.get(rel)!
          expect(c.kind).toBe(o.kind)
          if (o.kind === 'file' && c.sha !== o.sha) changed.push(rel)
          if (o.kind !== 'dir') expect(Math.abs(c.mtimeMs - o.mtimeMs)).toBeLessThan(2)
        }
        // The only differences are the rewritten memory markdown files.
        expect(changed.every((r) => r.startsWith('memory/') && r.endsWith('.md'))).toBe(true)
        // Roadmap cards (approval-stamped) are never among them.
        expect(changed.some((r) => r.startsWith('memory/roadmap/'))).toBe(false)
        expect(changed.length).toBe((res as { rewrittenMd: number }).rewrittenMd)
        for (const rel of changed) {
          const text = readFileSync(join(repo, '.harnu', rel), 'utf8')
          expect(text).not.toMatch(/(?<![A-Za-z0-9_])\.capy\//)
        }

        // Every roadmap card is byte-identical to its original.
        const cards = [...orig.values()].filter(
          (e) => e.kind === 'file' && e.rel.startsWith('memory/roadmap/')
        )
        for (const o of cards) expect(copied.get(o.rel)?.sha, o.rel).toBe(o.sha)
        // The new dir is kept out of git (both names), so it never shows as untracked.
        const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
        expect(exclude).toContain('/.harnu/')
        expect(exclude).toContain('/.capy/')
        expect(execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString()).toBe('')

        const files = (es: Entry[]): { n: number; bytes: number } => {
          const f = es.filter((e) => e.kind === 'file')
          return { n: f.length, bytes: f.reduce((a, e) => a + e.size, 0) }
        }
        const summary = {
          legacy: files(before),
          target: files(copy),
          targetWithoutMarker: files(copy.filter((e) => e.rel !== marker)),
          markdownRewritten: changed.length,
          roadmapCards: cards.length,
          roadmapCardsByteIdentical: cards.every((o) => copied.get(o.rel)?.sha === o.sha),
          excludeHasHarnu: exclude.includes('/.harnu/'),
          legacyUntouched: JSON.stringify(after) === JSON.stringify(before),
          legacyChecksums: before.filter((e) => e.kind === 'file').length
        }
        if (REPORT) writeFileSync(REPORT, JSON.stringify(summary, null, 2))
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }, 120_000)
  }
)
