import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// "Ask for an opinion" is advisory, on demand and read-only (T444 AC-1, AC-2, AC-5). These are
// source-level guards for the properties a unit test of the core cannot see: who can reach the
// advisor, that nothing re-runs it, and that its shell only ever reads.

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  )
}

const MAIN = walk(join(ROOT, 'src/main')).map((f) => relative(ROOT, f))
const OPINION_FILES = ['src/main/gc/opinion-core.ts', 'src/main/gc/opinion-shell.ts']

/** Code without comments, so a comment that names what the file must not do is not a hit. */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('the advisor is reachable only on demand (AC-5)', () => {
  it('is imported by gc-ipc.ts and nothing else in the main process', () => {
    const importers = MAIN.filter(
      (f) => !OPINION_FILES.includes(f) && /from '[^']*\/opinion-(core|shell)'/.test(read(f))
    )
    expect(importers.sort()).toEqual(['src/main/gc/gc-ipc.ts', 'src/main/gc/gc-wire.ts'].sort())
  })

  it('is not mentioned by the cycle, the autopilot, the pipeline or the Reaper and Scheduler', () => {
    const quiet = MAIN.filter(
      (f) =>
        (f.startsWith('src/main/gc/') ||
          f.startsWith('src/main/reaper/') ||
          f.startsWith('src/main/containers/') ||
          /^src\/main\/scheduler-/.test(f)) &&
        !OPINION_FILES.includes(f) &&
        f !== 'src/main/gc/gc-ipc.ts' &&
        f !== 'src/main/gc/gc-wire.ts' &&
        /opinion/i.test(read(f))
    )
    expect(MAIN.some((f) => f.startsWith('src/main/gc/autopilot-core'))).toBe(true)
    expect(quiet).toEqual([])
  })

  it('is not wired into the cycle deps or the Reaper tick inside gc-ipc.ts', () => {
    const ipc = read('src/main/gc/gc-ipc.ts')
    const from = ipc.indexOf('const cycleDeps')
    const to = ipc.indexOf('reaper.setBusy(')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    expect(ipc.slice(from, to)).not.toMatch(/opinion/i)
  })

  it('is started from the gc:opinion handler and from the service method behind it only', () => {
    const ipc = read('src/main/gc/gc-ipc.ts')
    expect(ipc.match(/opinions\.start\(/g)).toHaveLength(1)
    expect(ipc.match(/service\.opinion\(/g)).toHaveLength(1)
    expect(ipc).toContain(
      "ipcMain.handle('gc:opinion', (_e, ids: unknown) => service.opinion(ids))"
    )
  })

  it('never retries: the core runs the model once per batch and the shell has no timer loop', () => {
    const core = read('src/main/gc/opinion-core.ts')
    const shell = read('src/main/gc/opinion-shell.ts')
    expect(core.match(/deps\.run\(/g)).toHaveLength(1)
    expect(core).not.toMatch(/setInterval|setTimeout|retry|attempts/i)
    expect(shell).not.toMatch(/setInterval|retry|attempts/i)
    // The one timer is the kill switch of a hung process.
    expect(shell.match(/setTimeout\(/g)).toHaveLength(1)
    expect(shell).toMatch(/child\.kill\('SIGTERM'\)/)
  })
})

describe('the advisor can only read (AC-2)', () => {
  const FORBIDDEN =
    /submitManualClean|createGcOps|createForcedGcOps|runHousekeeping|gc:clean|\bgcClean\b|\.rm\(|rmSync|unlink|trashItem|worktree remove|branch -[dD]|docker\b.*\brm\b|volume rm/

  it.each(OPINION_FILES)('%s reaches no removal path', (file) => {
    expect(code(file)).not.toMatch(FORBIDDEN)
  })

  it('only runs read-only git subcommands', () => {
    const shell = read('src/main/gc/opinion-shell.ts')
    const subcommands = [...shell.matchAll(/opts\.git\([^[]*\[\s*'([a-z-]+)'/g)].map((m) => m[1])
    expect(subcommands.length).toBeGreaterThan(0)
    for (const sub of subcommands) {
      expect(['symbolic-ref', 'diff', 'status', 'rev-parse']).toContain(sub)
    }
  })

  it('spawns claude with the argv it was given and nothing it added', () => {
    const shell = read('src/main/gc/opinion-shell.ts')
    expect(shell.match(/spawn\(/g)).toHaveLength(1)
    expect(shell).toContain('spawn(bin, a.argv,')
    expect(shell).not.toMatch(/--dangerously|bypassPermissions|--allowedTools|--mcp-config/)
  })

  it('takes the argv from opinionArgv, which is built on the Scheduler tickArgv', () => {
    const core = read('src/main/gc/opinion-core.ts')
    expect(core).toContain("from '../scheduler-core'")
    expect(core).toMatch(/tickArgv\(/)
    expect(core).toMatch(/mode: 'observe'/)
    expect(core).not.toMatch(/mode: 'act'/)
  })
})

describe('the channels (AC-1)', () => {
  it('registers gc:opinion and pushes the result and done channels', () => {
    const ipc = read('src/main/gc/gc-ipc.ts')
    expect(ipc).toContain("'gc:opinion:result'")
    expect(ipc).toContain("'gc:opinion:done'")
  })

  it('exposes the same three channels through the preload', () => {
    const preload = read('src/preload/index.ts')
    expect(preload).toContain("ipcRenderer.invoke('gc:opinion', ids)")
    expect(preload).toContain("subscribe('gc:opinion:result', cb)")
    expect(preload).toContain("subscribe('gc:opinion:done', cb)")
  })
})
