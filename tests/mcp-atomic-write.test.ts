import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { atomicWriteFile } from '../src/main/mcp/atomic-write'

/**
 * T123 §3.1 AC15 (BUG-32) — `capy.mcp.json` must be written atomically so no
 * reader ever observes a partial file across a control-server restart. These
 * pin the temp-file + rename contract directly against a real tmp directory
 * (no electron dependency, per ADR-0001 pure-core/thin-shell).
 */
describe('atomicWriteFile', () => {
  let dir: string
  let target: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mcp-atomic-'))
    target = path.join(dir, 'capy.mcp.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes the full content to the target path', async () => {
    await atomicWriteFile(target, '{"hello":"world"}\n', 0o600)
    expect(await fs.readFile(target, 'utf8')).toBe('{"hello":"world"}\n')
  })

  it('applies the given mode to the final file', async () => {
    await atomicWriteFile(target, '{}', 0o600)
    const stat = await fs.stat(target)
    // POSIX permission bits only (mask off file-type bits).
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('leaves no temp file behind after a successful write', async () => {
    await atomicWriteFile(target, '{}', 0o600)
    const entries = await fs.readdir(dir)
    expect(entries).toEqual(['capy.mcp.json'])
  })

  it('overwrites prior content completely (not merged/appended)', async () => {
    await atomicWriteFile(target, '{"v":1}', 0o600)
    await atomicWriteFile(target, '{"v":2}', 0o600)
    expect(await fs.readFile(target, 'utf8')).toBe('{"v":2}')
  })

  it('a reader never observes a partial file: it sees either the old or new complete content', async () => {
    await atomicWriteFile(target, 'OLD-COMPLETE-CONTENT', 0o600)

    // Simulate a concurrent reader racing the second write: start the write,
    // then read the target as soon as possible. Because the write goes to a
    // temp file first and only `rename()`s at the very end, every read here
    // must return one of the two complete strings — never a truncated one.
    const writeDone = atomicWriteFile(target, 'NEW-COMPLETE-CONTENT-LONGER', 0o600)
    const reads = await Promise.all(
      Array.from({ length: 20 }, () => fs.readFile(target, 'utf8').catch(() => null))
    )
    await writeDone

    for (const content of reads) {
      if (content === null) continue // ENOENT is acceptable mid-rename on some fs, but never partial
      expect(['OLD-COMPLETE-CONTENT', 'NEW-COMPLETE-CONTENT-LONGER']).toContain(content)
    }
    expect(await fs.readFile(target, 'utf8')).toBe('NEW-COMPLETE-CONTENT-LONGER')
  })

  it('cleans up the temp file if the rename fails', async () => {
    // Make the target path an existing, non-empty directory so the temp-file
    // write succeeds (its parent, `dir`, exists) but `rename()` onto a
    // non-empty directory fails (ENOTEMPTY/EISDIR/EPERM depending on OS).
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'placeholder'), 'x')

    await expect(atomicWriteFile(target, '{}', 0o600)).rejects.toThrow()

    const entries = await fs.readdir(dir)
    // Only the pre-existing directory remains — no leaked `.tmp` sibling.
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([])
  })

  it('cleans up the temp file if the INITIAL write itself fails (C-3)', async () => {
    // Regression net for C-3: the write used to happen OUTSIDE the try/catch,
    // so a partial temp file left by a hard initial-write failure (ENOSPC,
    // a killed process, ...) was never unlinked. Simulate that by making the
    // directory read-only so `fs.writeFile(tmp, ...)` itself fails (EACCES)
    // before any bytes land — not a rename/chmod failure like the test above.
    await fs.chmod(dir, 0o555)
    try {
      await expect(atomicWriteFile(target, '{}', 0o600)).rejects.toThrow()
    } finally {
      // Restore write permission so afterEach's recursive rm (and the
      // readdir assertion below) can actually run.
      await fs.chmod(dir, 0o700)
    }

    const entries = await fs.readdir(dir)
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([])
  })
})
