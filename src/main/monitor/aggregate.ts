/**
 * A flat process list plus a root pid → the subtree total (T127). PURE tree fold —
 * no I/O, no clock. `/proc` gives us a flat list of `{ pid, ppid }` pairs; a
 * session's "cost" is the sum over its shell pid and every descendant reached by
 * following `ppid` links (the `claude` process, its MCP `node` child, etc.).
 *
 * Spec: docs/specs/T127-system-monitor.md §6.1.
 */

/** The minimal shape this module needs from a `/proc`-derived process reading. */
export interface ProcNode {
  pid: number
  ppid: number
  cpuPct: number | null
  rssBytes: number | null
}

export interface SubtreeTotal {
  cpuPct: number | null
  rssBytes: number | null
}

/** pid → its direct children's pids, from the flat `ppid` links. */
function childrenIndex(procs: readonly ProcNode[]): Map<number, number[]> {
  const idx = new Map<number, number[]>()
  for (const p of procs) {
    const list = idx.get(p.ppid)
    if (list) list.push(p.pid)
    else idx.set(p.ppid, [p.pid])
  }
  return idx
}

/**
 * Every pid in the subtree rooted at `rootPid` (root included), via `ppid` links.
 * A `seen` guard makes a malformed/cyclic `ppid` chain terminate instead of looping
 * forever — `/proc` should never produce a cycle, but this is untrusted input.
 */
export function subtreePids(procs: readonly ProcNode[], rootPid: number): number[] {
  const idx = childrenIndex(procs)
  const seen = new Set<number>()
  const out: number[] = []
  const stack = [rootPid]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    for (const child of idx.get(pid) ?? []) stack.push(child)
  }
  return out
}

/**
 * Sum `cpuPct`/`rssBytes` over the subtree rooted at `rootPid`. Each field stays
 * `null` (unknown), never rounds down to `0`, when NONE of the subtree's readings
 * for that field are known — e.g. every pid came from a `NullSampler` platform.
 * A root pid absent from `procs` (already dead, or never sampled) yields
 * `{ cpuPct: null, rssBytes: null }`.
 */
export function aggregateSubtree(procs: readonly ProcNode[], rootPid: number): SubtreeTotal {
  const byPid = new Map(procs.map((p) => [p.pid, p] as const))
  const pids = subtreePids(procs, rootPid).filter((pid) => byPid.has(pid))
  let cpuSum = 0
  let cpuKnown = false
  let rssSum = 0
  let rssKnown = false
  for (const pid of pids) {
    const node = byPid.get(pid) as ProcNode
    if (node.cpuPct !== null) {
      cpuSum += node.cpuPct
      cpuKnown = true
    }
    if (node.rssBytes !== null) {
      rssSum += node.rssBytes
      rssKnown = true
    }
  }
  return { cpuPct: cpuKnown ? cpuSum : null, rssBytes: rssKnown ? rssSum : null }
}
