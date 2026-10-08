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
const OPINION_FILES = [
  'src/main/gc/opinion-core.ts',
  'src/main/gc/opinion-shell.ts',
  'src/main/gc/opinion-run.ts',
  'src/main/gc/opinion-git.ts'
]

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

  it('never retries: the core runs the model once per batch, only the runner owns timers', () => {
    const core = read('src/main/gc/opinion-core.ts')
    const shell = read('src/main/gc/opinion-shell.ts')
    const run = read('src/main/gc/opinion-run.ts')
    expect(core.match(/deps\.run\(/g)).toHaveLength(1)
    expect(core).not.toMatch(/setInterval|setTimeout|retry|attempts/i)
    expect(shell).not.toMatch(/setInterval|setTimeout|retry|attempts/i)
    expect(run).not.toMatch(/setInterval|retry|attempts/i)
    // The runner's two timers are the bounded kill switch of one process: SIGTERM at the timeout,
    // SIGKILL after the grace. Neither starts a new run.
    expect(run.match(/setTimeout\(/g)).toHaveLength(2)
    expect(run).toContain("'SIGTERM'")
    expect(run).toContain("'SIGKILL'")
    expect(shell).toContain('runSupervised(')
  })
})

describe('the advisor can only read (AC-2)', () => {
  const FORBIDDEN =
    /submitManualClean|createGcOps|createForcedGcOps|runHousekeeping|gc:clean|\bgcClean\b|\.rm\(|rmSync|unlink|trashItem|worktree remove|branch -[dD]|docker\b.*\brm\b|volume rm/

  it.each(OPINION_FILES)('%s reaches no removal path', (file) => {
    expect(code(file)).not.toMatch(FORBIDDEN)
  })

  it('only runs read-only git subcommands', () => {
    const gitFile = code('src/main/gc/opinion-git.ts')
    const subcommands = [...gitFile.matchAll(/\bgit\([^[]*\[\s*'([a-z-]+)'/g)].map((m) => m[1])
    expect(subcommands.length).toBeGreaterThan(0)
    for (const sub of subcommands) {
      expect(['symbolic-ref', 'diff', 'status', 'rev-parse']).toContain(sub)
    }
    // The shell runs no git command of its own: every git fact comes through the fail-closed gatherer.
    expect(code('src/main/gc/opinion-shell.ts')).not.toMatch(/opts\.git\(/)
    // No catch-all that turns an error into an empty value.
    expect(code('src/main/gc/opinion-shell.ts')).not.toMatch(
      /async function attempt|catch\s*\{\s*return ''/
    )
  })

  it('spawns claude with the argv it was given and nothing it added', () => {
    const shell = read('src/main/gc/opinion-shell.ts')
    const run = read('src/main/gc/opinion-run.ts')
    expect(shell).not.toMatch(/spawn\(/)
    expect(shell).toContain('runSupervised(bin, a.argv,')
    expect(run.match(/spawn\(/g)).toHaveLength(1)
    expect(run).toContain('spawn(cmd, args,')
    for (const file of [shell, run]) {
      expect(file).not.toMatch(/--dangerously|bypassPermissions|--allowedTools|--mcp-config/)
    }
  })

  it('feeds the prompt on stdin and never as an argv element', () => {
    const shell = read('src/main/gc/opinion-shell.ts')
    const run = read('src/main/gc/opinion-run.ts')
    expect(shell).toContain('stdin: a.stdin')
    expect(run).toContain("stdio: ['pipe', 'pipe', 'pipe']")
    expect(run).toMatch(/child\.stdin\??\.end\(/)
  })

  it('stages no skill or plugin and builds argv from an empty tick context', () => {
    const core = read('src/main/gc/opinion-core.ts')
    // The Scheduler stages bundled skills with `--plugin-dir`; a skill's `hooks:` would run commands.
    for (const rel of [...OPINION_FILES]) {
      expect(code(rel), rel).not.toMatch(
        /stageSkillsForFolder|bundled-skills|pluginDir|companionPluginDir|hookSettingsJson|hook-bridge|--plugin-dir|--add-dir|--mcp-config/
      )
    }
    // `tickArgv(worker, {})`: the context carries no plugin dir, MCP config or hook blob.
    expect(code('src/main/gc/opinion-core.ts')).toMatch(/\},\s*\{\}\s*\)/)
    expect(core).toContain("mode: 'observe'")
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

  it('registers the read-only peek, which only reads main’s cache', () => {
    const ipc = read('src/main/gc/gc-ipc.ts')
    expect(ipc).toContain(
      "ipcMain.handle('gc:opinion:cached', (_e, ids: unknown) => service.opinionCached(ids))"
    )
    expect(ipc.match(/opinions\.cached\(/g)).toHaveLength(1)
    const preload = read('src/preload/index.ts')
    expect(preload).toContain("ipcRenderer.invoke('gc:opinion:cached', ids)")
  })

  it('exposes the same three channels through the preload', () => {
    const preload = read('src/preload/index.ts')
    expect(preload).toContain("ipcRenderer.invoke('gc:opinion', ids)")
    expect(preload).toContain("subscribe('gc:opinion:result', cb)")
    expect(preload).toContain("subscribe('gc:opinion:done', cb)")
  })
})
