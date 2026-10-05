import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BUG-75 — the probe split. `git status --porcelain` emits `??` records for
 * untracked paths, so "any output at all" conflated a tracked file the operator
 * edited with a stray file git was never asked to track. Cleanup must block on
 * the first and disclose the second.
 *
 * Two things are asserted here and they pull in opposite directions on purpose:
 * {@link probeWorktreeStatus} splits the two, and {@link isWorktreeDirty} — the
 * pre-flight gate of the manual **Remove worktree** path — does NOT (AC-5).
 */

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => {
  const CUSTOM = Symbol.for('nodejs.util.promisify.custom')
  const execFile: unknown = () => {
    throw new Error('execFile called in its callback form — tests only stub the promisified form')
  }
  ;(execFile as Record<symbol, unknown>)[CUSTOM] = (...args: unknown[]) => execFileMock(...args)
  return { execFile }
})
// worktree-ipc.ts pulls in `electron` (ipcMain) — never touched by these seams.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { parsePorcelainStatus } from '../src/main/worktree-core'
import { probeWorktreeStatus, isWorktreeDirty } from '../src/main/worktree-ipc'

/** `git status --porcelain -z` output: every record NUL-TERMINATED, never quoted. */
function z(...records: string[]): string {
  return records.map((r) => `${r}\0`).join('')
}

beforeEach(() => {
  execFileMock.mockReset()
})

describe('parsePorcelainStatus', () => {
  it('a clean worktree is neither tracked-dirty nor carrying untracked paths', () => {
    expect(parsePorcelainStatus('')).toEqual({ trackedDirty: false, untracked: [] })
  })

  it('untracked-only output is NOT tracked-dirty — the whole point of the split', () => {
    const status = parsePorcelainStatus(z('?? docs/adr/0013-draft.md', '?? scratch/'))
    expect(status.trackedDirty).toBe(false)
    expect(status.untracked).toEqual(['docs/adr/0013-draft.md', 'scratch/'])
  })

  it('a tracked modification is tracked-dirty, staged or not', () => {
    expect(parsePorcelainStatus(z(' M src/a.ts')).trackedDirty).toBe(true)
    expect(parsePorcelainStatus(z('M  src/a.ts')).trackedDirty).toBe(true)
    expect(parsePorcelainStatus(z('A  src/new.ts')).trackedDirty).toBe(true)
    expect(parsePorcelainStatus(z(' D src/gone.ts')).trackedDirty).toBe(true)
    expect(parsePorcelainStatus(z('UU src/conflict.ts')).trackedDirty).toBe(true)
  })

  it('reports both axes at once when tracked edits and untracked files coexist', () => {
    const status = parsePorcelainStatus(z(' M src/a.ts', '?? notes.md'))
    expect(status).toEqual({ trackedDirty: true, untracked: ['notes.md'] })
  })

  it('consumes a rename record’s source field instead of reading it as a record', () => {
    // `R  new\0old\0?? stray\0` — a naive split would read `old` as a record.
    const status = parsePorcelainStatus(z('R  src/new.ts', 'src/old.ts', '?? stray.txt'))
    expect(status.trackedDirty).toBe(true)
    expect(status.untracked).toEqual(['stray.txt'])
  })

  /**
   * BUG-124 — a rename's source field must be consumed whichever COLUMN carries
   * the `R`. These fixtures are byte-for-byte `git status --porcelain -z` output
   * captured from git 2.43.0 in a throwaway repo (README.md + GUIDE.md committed,
   * then `important-note.md` and `zz-other.md` created untracked) — never
   * hand-written, because a hand-written `-z` fixture encodes what its author
   * believes git emits, and this bug lived in the gap between that and git:
   *
   * - UNSTAGED: `mv README.md ZZ-renamed.md && git add -N ZZ-renamed.md`
   * - STAGED:   `git mv README.md ZZ-renamed.md`
   * - BOTH:     `git mv GUIDE.md AA-staged.md`, then
   *             `mv README.md ZZ-unstaged.md && git add -N ZZ-unstaged.md`
   * - COPY:     `cp README.md ZZ-copied.md && git add -N ZZ-copied.md`, then
   *             append a line to README.md, read with `-c status.renames=copies`
   *             (the probe does not pin rename detection, so a user's config can
   *             turn this on; git only reports a copy whose source is modified)
   *
   * The unstaged source is `README.md` on purpose: an unconsumed source field
   * only swallows the next record when its own first byte is `R`/`C`. With a
   * `GUIDE.md` source the old parser passed BOTH by accident.
   */
  const UNSTAGED_RENAME = ' R ZZ-renamed.md\0README.md\0?? important-note.md\0?? zz-other.md\0'
  const STAGED_RENAME = 'R  ZZ-renamed.md\0README.md\0?? important-note.md\0?? zz-other.md\0'
  const BOTH_RENAMES =
    'R  AA-staged.md\0GUIDE.md\0 R ZZ-unstaged.md\0README.md\0?? important-note.md\0?? zz-other.md\0'
  const UNSTAGED_COPY =
    ' M README.md\0 C ZZ-copied.md\0README.md\0?? important-note.md\0?? zz-other.md\0'

  it('consumes an UNSTAGED rename’s source field (` R`), so the next record parses intact', () => {
    // Before the fix, `README.md` was read as a record, its first byte `R` fired
    // the skip, and `?? important-note.md` was swallowed.
    expect(parsePorcelainStatus(UNSTAGED_RENAME)).toEqual({
      trackedDirty: true,
      untracked: ['important-note.md', 'zz-other.md']
    })
  })

  it('parses a STAGED rename (`R `) exactly as before', () => {
    expect(parsePorcelainStatus(STAGED_RENAME)).toEqual({
      trackedDirty: true,
      untracked: ['important-note.md', 'zz-other.md']
    })
  })

  it('consumes both source fields when a staged and an unstaged rename share one status', () => {
    expect(parsePorcelainStatus(BOTH_RENAMES)).toEqual({
      trackedDirty: true,
      untracked: ['important-note.md', 'zz-other.md']
    })
  })

  it('consumes an UNSTAGED copy’s source field (` C`) the same way', () => {
    expect(parsePorcelainStatus(UNSTAGED_COPY)).toEqual({
      trackedDirty: true,
      untracked: ['important-note.md', 'zz-other.md']
    })
  })

  it('keeps paths with spaces intact (why the probe passes -z, not the quoting default)', () => {
    const status = parsePorcelainStatus(z('?? my notes.md', '?? café/plán.txt'))
    expect(status.untracked).toEqual(['my notes.md', 'café/plán.txt'])
  })

  it('ignores `!!` records, so adding --ignored could never invent a blocker', () => {
    expect(parsePorcelainStatus(z('!! node_modules/'))).toEqual({
      trackedDirty: false,
      untracked: []
    })
  })
})

describe('probeWorktreeStatus', () => {
  it('runs `git status --porcelain -z` in the worktree and splits the result', async () => {
    execFileMock.mockResolvedValue({ stdout: z(' M src/a.ts', '?? notes.md'), stderr: '' })
    const status = await probeWorktreeStatus('/repo/wt-x')
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock.mock.calls[0][1]).toEqual([
      '-C',
      '/repo/wt-x',
      'status',
      '--porcelain',
      '-z'
    ])
    expect(status).toEqual({ trackedDirty: true, untracked: ['notes.md'] })
  })

  it('propagates a git failure so callers keep their own fail-closed handling', async () => {
    execFileMock.mockRejectedValue(new Error('git timed out'))
    await expect(probeWorktreeStatus('/repo/wt-x')).rejects.toThrow('git timed out')
  })
})

/**
 * AC-5 — `isWorktreeDirty` is the pre-flight gate of `worktree:remove`, a
 * destructive path unrelated to Cleanup. BUG-75 adds a probe beside it; it must
 * not loosen it. Both assertions below fail the moment someone rewires this
 * function to the split probe: the verdict flips to false, and the argv gains
 * `-z`.
 */
describe('isWorktreeDirty — unchanged for worktree:remove (AC-5)', () => {
  it('still reports TRUE for an untracked-only worktree', async () => {
    execFileMock.mockResolvedValue({ stdout: '?? docs/adr/0013-draft.md\n', stderr: '' })
    await expect(isWorktreeDirty('/repo/wt-x')).resolves.toBe(true)
  })

  it('still shells out to the bare `git status --porcelain` (no -z, no split)', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
    await isWorktreeDirty('/repo/wt-x')
    expect(execFileMock.mock.calls[0][1]).toEqual(['-C', '/repo/wt-x', 'status', '--porcelain'])
  })

  it('still reports TRUE for a tracked modification and FALSE for a clean tree', async () => {
    execFileMock.mockResolvedValue({ stdout: ' M src/a.ts\n', stderr: '' })
    await expect(isWorktreeDirty('/repo/wt-x')).resolves.toBe(true)
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(isWorktreeDirty('/repo/wt-x')).resolves.toBe(false)
  })
})
