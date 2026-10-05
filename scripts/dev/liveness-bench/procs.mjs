// Per-process CPU labelled by Electron's own process type (`app.getAppMetrics()`):
// Browser (main) / Tab (renderer) / GPU / Utility / Zygote. Replaces the old
// `/proc/<pid>/cmdline` `--type=` guess, which labelled the GPU process `zygote`
// (spec §1.1) — the type comes from the main inspector, ticks from /proc.
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'

export const PAGE_PORT = Number(process.env.PAGE_PORT ?? 9347)
export const NODE_PORT = Number(process.env.NODE_PORT ?? 9348)

/** Evaluate in the main process through the Node inspector (`node` = a cdp.mjs connection). */
export async function mainEval(node, expression) {
  const r = await node.send('Runtime.evaluate', {
    expression,
    includeCommandLineAPI: true,
    awaitPromise: true,
    returnByValue: true
  })
  return r.result?.result?.value
}

/**
 * Refuse to drive an instance that is not isolated: the bench sets debugger logpoints (which
 * pause the main process) and writes fixture files, so it must never attach to the operator's
 * real Harnu. An isolated instance runs with a fake `HOME`; the real one runs with the
 * account's passwd home (read from the passwd database, not `$HOME`, which the bench's own
 * shell may have overridden).
 */
export async function assertIsolated(node) {
  const home = await mainEval(node, `process.env.HOME`)
  if (!home || home === userInfo().homedir) {
    throw new Error(
      `refusing to attach: the instance on NODE_PORT ${NODE_PORT} runs with HOME=${home} ` +
        `(the real home). Launch an isolated instance with a fake HOME and --user-data-dir ` +
        `(see README).`
    )
  }
}

/** [{ pid, type }] for every process Electron manages in the instance under test. */
export async function appProcs(node) {
  const json = await mainEval(
    node,
    `JSON.stringify(require('electron').app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type })))`
  )
  return JSON.parse(json)
}

/** utime + stime clock ticks of `pid` (fields 14, 15 of /proc/<pid>/stat). */
export function ticks(pid) {
  const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ')
  return Number(f[11]) + Number(f[12])
}

/** Start a CPU window; the returned `end()` resolves to [{ pid, type, cpuPct }] and the wall seconds. */
export async function startCpuWindow(node) {
  const procs = await appProcs(node)
  const t0 = Object.fromEntries(procs.map((p) => [p.pid, ticks(p.pid)]))
  const wall0 = Date.now()
  return {
    procs,
    end() {
      const wall = (Date.now() - wall0) / 1000
      const cpu = procs.map((p) => {
        let t1 = t0[p.pid]
        try {
          t1 = ticks(p.pid) // a process that exited mid-window keeps its start ticks
        } catch {
          /* gone */
        }
        return { ...p, cpuPct: +(((t1 - t0[p.pid]) / 100 / wall) * 100).toFixed(1) }
      })
      return { wall, cpu }
    }
  }
}
