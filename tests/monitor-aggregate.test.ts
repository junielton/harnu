import { describe, it, expect } from 'vitest'
import { subtreePids, aggregateSubtree, type ProcNode } from '../src/main/monitor/aggregate'

function node(pid: number, ppid: number, over: Partial<ProcNode> = {}): ProcNode {
  return { pid, ppid, cpuPct: 0, rssBytes: 0, ...over }
}

// A small process tree: shell(1) -> claude(2) -> node/mcp(3), plus an unrelated pid(9).
const TREE: ProcNode[] = [
  node(1, 0, { cpuPct: 1, rssBytes: 10 }),
  node(2, 1, { cpuPct: 9, rssBytes: 280 }),
  node(3, 2, { cpuPct: 3, rssBytes: 60 }),
  node(9, 0, { cpuPct: 99, rssBytes: 999 })
]

describe('subtreePids', () => {
  it('includes the root and every transitive descendant, excludes unrelated pids', () => {
    expect(subtreePids(TREE, 1).sort()).toEqual([1, 2, 3])
  })

  it('a leaf pid’s subtree is just itself', () => {
    expect(subtreePids(TREE, 3)).toEqual([3])
  })

  it('a root with no matching entry still returns the root pid (empty subtree otherwise)', () => {
    expect(subtreePids(TREE, 404)).toEqual([404])
  })

  it('terminates on a malformed cyclic ppid chain instead of looping forever', () => {
    const cyclic: ProcNode[] = [node(1, 2), node(2, 1)]
    expect(subtreePids(cyclic, 1).sort()).toEqual([1, 2])
  })
})

describe('aggregateSubtree', () => {
  it('sums cpuPct and rssBytes over the whole subtree', () => {
    expect(aggregateSubtree(TREE, 1)).toEqual({ cpuPct: 1 + 9 + 3, rssBytes: 10 + 280 + 60 })
  })

  it('a leaf subtree is just its own numbers', () => {
    expect(aggregateSubtree(TREE, 3)).toEqual({ cpuPct: 3, rssBytes: 60 })
  })

  it('a root absent from the process list yields null, not 0', () => {
    expect(aggregateSubtree(TREE, 404)).toEqual({ cpuPct: null, rssBytes: null })
  })

  it('a field stays null when NONE of the subtree knows it (NullSampler platform)', () => {
    const unsampled: ProcNode[] = [
      node(1, 0, { cpuPct: null, rssBytes: null }),
      node(2, 1, { cpuPct: null, rssBytes: null })
    ]
    expect(aggregateSubtree(unsampled, 1)).toEqual({ cpuPct: null, rssBytes: null })
  })

  it('sums only the KNOWN readings when some subtree members are null, never rounds to 0', () => {
    const partial: ProcNode[] = [
      node(1, 0, { cpuPct: null, rssBytes: 50 }),
      node(2, 1, { cpuPct: 7, rssBytes: null })
    ]
    expect(aggregateSubtree(partial, 1)).toEqual({ cpuPct: 7, rssBytes: 50 })
  })
})
