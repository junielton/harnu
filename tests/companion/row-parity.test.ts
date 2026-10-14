import { beforeAll, describe, expect, it } from 'vitest'
import {
  ACTIVITY_MATCH_MS,
  compareRowGroups,
  ROW_CLASSES,
  type RowClass,
  type RowCompareInput,
  type RowGroupRecord
} from '../../src/main/companion/ingest/row-parity-core'
import {
  buildParityRecord,
  gateStatus,
  parityReport,
  type ParityRecord
} from '../../src/main/companion/parity-core'
import {
  compareRowRecords,
  registerRowParityRule,
  rowGateRecords
} from '../../src/main/companion/parity-row-rule'
import type { RowGroup } from '../../src/main/companion/arbitration-core'

/**
 * T455 W2 AC-7: the `row` parity stream (spec §7.3 with the W0 findings' M1, M2, M3a, M3b and the
 * classes the W1 verifiers established). Synthetic inputs only: every text below is made up.
 */

const MiB = 1024 * 1024

function base(): RowCompareInput {
  return {
    push: {
      firstPrompt: 'list the files',
      lastPrompt: '/hello world',
      lastAssistant: 'Finished.',
      title: null,
      userRows: 4,
      lastRowAt: 1_790_000_000_000,
      lastUuid: 'u-4',
      toolCalls5m: 2,
      subagentToolCalls5m: 0
    },
    baseline: null,
    legacy: {
      firstPrompt: 'list the files',
      lastPrompt: '/hello world',
      customTitle: '',
      userMessageCount: 4,
      mtimeMs: 1_790_000_000_400,
      size: 10_000,
      lastAssistant: 'Finished.',
      uuidFound: true,
      rowsAfter: 0,
      recentPrompts: [
        { text: 'list the files', shape: 'typed' },
        { text: '/hello world', shape: 'command' }
      ],
      firstRow: { shape: 'typed', rawLength: 14, windowWord: true },
      toolCalls5m: 2
    },
    headless: false,
    turnReason: 'answer'
  }
}

type Patch = (x: RowCompareInput) => void
const input = (...patches: Patch[]): RowCompareInput => {
  const x = base()
  for (const p of patches) p(x)
  return x
}
const rec = (records: RowGroupRecord[], g: RowGroup): RowGroupRecord =>
  records.find((r) => r.group === g)!

describe('compareRowGroups: shape and matches (AC-7)', () => {
  it('one record per group, in a fixed order, with exactly the five ledger keys', () => {
    const out = compareRowGroups(base())
    expect(out.map((r) => r.group)).toEqual([
      'prompt',
      'count',
      'activity',
      'assistant',
      'title',
      'tools'
    ])
    for (const r of out) {
      expect(Object.keys(r).sort()).toEqual(['cls', 'group', 'lenLegacy', 'lenPush', 'verdict'])
      expect(r).toMatchObject({ verdict: 'match', cls: 'none' })
    }
  })

  it('the detail keys survive the ledger scrubbing (none matches DENIED_KEY)', () => {
    for (const r of compareRowGroups(base())) {
      const p = buildParityRecord({
        stream: 'row',
        source: 'companion',
        owner: 'legacy',
        reason: 'mode-shadow',
        disposition: 'record-only',
        sid: 's',
        salt: 'salt-salt-salt-salt',
        t: 1,
        k: `group:${r.group}`,
        d: { ...r },
        cli: '2.1.296',
        mod: '0.1.0'
      })
      expect(Object.keys(p.d ?? {}).sort()).toEqual(
        Object.keys(r)
          .filter((k) => (r as unknown as Record<string, unknown>)[k] !== undefined)
          .sort()
      )
    }
  })

  it('texts go through the renderer normalizer: 120 vs 240 is not a divergence', () => {
    const long = 'word '.repeat(80).trim() // 399 chars
    const out = compareRowGroups(
      input((x) => {
        x.push.lastPrompt = long.slice(0, 239) + '…'
        x.legacy!.lastPrompt = long
        x.legacy!.recentPrompts = [{ text: long, shape: 'typed' }]
        x.push.firstPrompt = long.slice(0, 239) + '…'
        x.legacy!.firstPrompt = long.slice(0, 120)
      })
    )
    expect(rec(out, 'prompt')).toMatchObject({ verdict: 'match', cls: 'none' })
  })

  it('a resume composes the push over the cold baseline (§6.2)', () => {
    const out = compareRowGroups(
      input((x) => {
        x.baseline = { firstPrompt: 'old first', lastPrompt: 'old last', userMessageCount: 10 }
        x.push.firstPrompt = 'typed after resume'
        x.push.lastPrompt = null
        x.push.userRows = 2
        x.legacy!.firstPrompt = 'old first'
        x.legacy!.lastPrompt = 'old last'
        x.legacy!.userMessageCount = 12
      })
    )
    expect(rec(out, 'prompt').verdict).toBe('match')
    expect(rec(out, 'count')).toMatchObject({ verdict: 'match', lenPush: 12, lenLegacy: 12 })
  })

  it('M1 (W1 round 3): a lastUuid behind the file\'s last row is "not yet aligned" too', () => {
    // a user or assistant row the push has not folded yet sits after it in the file
    const out = compareRowGroups(
      input((x) => {
        x.legacy!.userMessageCount = 6
        x.legacy!.rowsAfter = 2
      })
    )
    for (const r of out) expect(r).toMatchObject({ verdict: 'unaligned', cls: 'none' })
  })

  it(`activity: |Δ| ≤ ${ACTIVITY_MATCH_MS} ms is a match, beyond it a divergence`, () => {
    const at = (delta: number) =>
      rec(
        compareRowGroups(
          input((x) => {
            x.legacy!.mtimeMs = x.push.lastRowAt! - delta
          })
        ),
        'activity'
      )
    expect(at(ACTIVITY_MATCH_MS)).toMatchObject({ verdict: 'match', lenPush: ACTIVITY_MATCH_MS })
    expect(at(-ACTIVITY_MATCH_MS)).toMatchObject({ verdict: 'match' })
    expect(at(ACTIVITY_MATCH_MS + 1)).toMatchObject({ verdict: 'diverge', cls: 'unexplained' })
  })

  it('M1: a lastUuid absent from the file is "not yet aligned", never a divergence', () => {
    const out = compareRowGroups(
      input((x) => {
        x.legacy!.uuidFound = false
        x.legacy!.userMessageCount = 1
        x.legacy!.lastPrompt = 'something else entirely'
      })
    )
    for (const r of out) expect(r).toMatchObject({ verdict: 'unaligned', cls: 'none' })
  })

  it('M2: the pushed title is compared with the custom title alone', () => {
    expect(rec(compareRowGroups(base()), 'title').verdict).toBe('match')
    const renamed = compareRowGroups(
      input((x) => {
        x.push.title = 'Renamed'
        x.legacy!.customTitle = 'Renamed'
      })
    )
    expect(rec(renamed, 'title').verdict).toBe('match')
    const off = compareRowGroups(
      input((x) => {
        x.push.title = 'Renamed'
      })
    )
    expect(rec(off, 'title')).toMatchObject({ verdict: 'diverge', cls: 'unexplained' })
  })

  it('an unknown push text (a mod reload) is not compared; no legacy is not compared', () => {
    const unknown = compareRowGroups(
      input((x) => {
        delete x.push.firstPrompt
        delete x.push.lastPrompt
      })
    )
    expect(rec(unknown, 'prompt').verdict).toBe('unknown')
    const none = compareRowGroups(input((x) => (x.legacy = null)))
    for (const r of none) expect(r.verdict).toBe('no-legacy')
  })
})

// ---- one test per named class, and the mutation that drops it ---------------------------------

const CASES: { cls: RowClass; group: RowGroup; expect: string; patch: Patch }[] = [
  {
    cls: 'E-HEAD',
    group: 'count',
    expect: 'E-HEAD',
    patch: (x) => {
      x.legacy!.size = 3 * MiB
      x.legacy!.userMessageCount = 3 // frozen at the 2 MiB head cap
    }
  },
  {
    cls: 'E-HEAD',
    group: 'prompt',
    expect: 'first:E-HEAD',
    patch: (x) => {
      x.legacy!.size = 3 * MiB
      x.legacy!.firstPrompt = ''
    }
  },
  {
    cls: 'E-TEAMMATE',
    group: 'prompt',
    expect: 'last:E-TEAMMATE',
    patch: (x) => {
      const reply =
        'Another Claude session sent a message: <teammate-message>done</teammate-message>'
      x.legacy!.lastPrompt = reply
      x.legacy!.recentPrompts = [...x.legacy!.recentPrompts, { text: reply, shape: 'teammate' }]
    }
  },
  {
    cls: 'E-SCHEDULED',
    group: 'prompt',
    expect: 'last:E-SCHEDULED',
    patch: (x) => {
      x.legacy!.lastPrompt = '/loop check the build'
      x.legacy!.recentPrompts = [
        ...x.legacy!.recentPrompts,
        { text: '/loop check the build', shape: 'scheduled' }
      ]
    }
  },
  {
    cls: 'E-ORIGIN',
    group: 'prompt',
    expect: 'last:E-ORIGIN',
    patch: (x) => {
      x.legacy!.lastPrompt = 'a message from another session'
      x.legacy!.recentPrompts = [
        ...x.legacy!.recentPrompts,
        { text: 'a message from another session', shape: 'peer' }
      ]
    }
  },
  {
    cls: 'E-ORIGIN',
    group: 'prompt',
    expect: 'first:E-ORIGIN',
    patch: (x) => {
      x.legacy!.firstPrompt = 'a message from another session'
      x.legacy!.firstRow = { shape: 'peer', rawLength: 30, windowWord: true }
    }
  },
  {
    cls: 'E-PLUGIN-BRIDGE',
    group: 'prompt',
    expect: 'last:E-PLUGIN-BRIDGE',
    patch: (x) => {
      x.legacy!.lastPrompt = 'sent from the phone'
      x.legacy!.recentPrompts = [
        ...x.legacy!.recentPrompts,
        { text: 'sent from the phone', shape: 'plugin-bridge' }
      ]
    }
  },
  {
    cls: 'E-HEADLESS',
    group: 'prompt',
    expect: 'last:E-HEADLESS',
    patch: (x) => {
      x.headless = true
      x.push.lastPrompt = null
      x.legacy!.lastPrompt = 'run the nightly report'
    }
  },
  {
    cls: 'E-RAWCAP',
    group: 'prompt',
    expect: 'first:E-RAWCAP',
    // W1 round 3: a meta wrapper closing past RAW_MAX gives null, and that row stays the first
    patch: (x) => {
      x.push.firstPrompt = null
      x.legacy!.firstPrompt = 'the real first prompt'
      x.legacy!.firstRow = { shape: 'typed', rawLength: 70_000, windowWord: true }
    }
  },
  {
    cls: 'E-RAWCAP-WINDOW',
    group: 'prompt',
    expect: 'first:E-RAWCAP-WINDOW',
    patch: (x) => {
      x.push.firstPrompt = null
      x.legacy!.firstPrompt = 'x'.repeat(120)
      x.legacy!.firstRow = { shape: 'typed', rawLength: 9_000, windowWord: false }
    }
  },
  {
    cls: 'E-REDACT',
    group: 'prompt',
    expect: 'last:E-REDACT',
    patch: (x) => {
      x.push.lastPrompt = 'use key [REDACTED:secret-assignment] now'
      x.legacy!.lastPrompt = 'use key value=abc123def now'
      x.legacy!.recentPrompts = [{ text: 'use key value=abc123def now', shape: 'typed' }]
    }
  },
  {
    cls: 'E-STOPLESS',
    group: 'assistant',
    expect: 'E-STOPLESS',
    patch: (x) => {
      x.turnReason = 'aborted'
      x.legacy!.lastAssistant = 'Partial answer before the interrupt'
    }
  },
  {
    cls: 'E-TAIL',
    group: 'tools',
    expect: 'E-TAIL',
    patch: (x) => {
      x.legacy!.size = 1 * MiB
      x.legacy!.toolCalls5m = 1
    }
  },
  {
    cls: 'E-SUBAGENT',
    group: 'tools',
    expect: 'E-SUBAGENT',
    patch: (x) => {
      x.push.subagentToolCalls5m = 3
      x.legacy!.toolCalls5m = 5
    }
  }
]

describe('named divergence classes (AC-7)', () => {
  it('every named class has a case below', () => {
    expect([...new Set(CASES.map((c) => c.cls))].sort()).toEqual([...ROW_CLASSES].sort())
  })

  for (const c of CASES) {
    it(`${c.cls} (${c.group}: ${c.expect})`, () => {
      expect(rec(compareRowGroups(input(c.patch)), c.group)).toMatchObject({
        verdict: 'diverge',
        cls: c.expect
      })
    })

    it(`mutation: without ${c.cls} the same case is unexplained`, () => {
      const without = new Set<RowClass>(ROW_CLASSES.filter((k) => k !== c.cls))
      const r = rec(compareRowGroups(input(c.patch), without), c.group)
      expect(r.verdict).toBe('diverge')
      expect(r.cls).toBe(c.expect.replace(c.cls, 'unexplained'))
    })
  }

  it('what fits no class is unexplained, counted honestly', () => {
    // an older typed prompt over a newer typed slash command (W0 §3.4): no class names it
    const older = compareRowGroups(
      input((x) => {
        x.legacy!.lastPrompt = 'list the files'
      })
    )
    expect(rec(older, 'prompt')).toMatchObject({ verdict: 'diverge', cls: 'last:unexplained' })
    // a line no stored row matches (W0's E-UNMATCHED is not a named class here)
    const unmatched = compareRowGroups(
      input((x) => {
        x.legacy!.lastPrompt = 'nothing in the tail looks like this'
      })
    )
    expect(rec(unmatched, 'prompt').cls).toBe('last:unexplained')
    // a count divergence under the head cap
    const count = compareRowGroups(input((x) => (x.legacy!.userMessageCount = 9)))
    expect(rec(count, 'count')).toMatchObject({ verdict: 'diverge', cls: 'unexplained' })
  })

  it('both prompt fields diverging are both reported', () => {
    const both = compareRowGroups(
      input(
        (x) => {
          x.legacy!.lastPrompt = 'list the files'
        },
        (x) => {
          x.legacy!.firstPrompt = 'something else'
        }
      )
    )
    expect(rec(both, 'prompt').cls).toBe('last:unexplained+first:unexplained')
  })
})

// ---- the ledger rule and the gate input -------------------------------------------------------

const SALT = 'salt-salt-salt-salt'
let t = 0
function ledgerRow(sid: string, r: RowGroupRecord): ParityRecord {
  return buildParityRecord({
    stream: 'row',
    source: 'companion',
    owner: 'legacy',
    reason: 'mode-shadow',
    disposition: 'record-only',
    sid,
    salt: SALT,
    t: ++t,
    k: `group:${r.group}`,
    d: { ...r },
    cli: '2.1.296',
    mod: '0.1.0'
  })
}

describe('the row ledger rule (AC-7)', () => {
  beforeAll(() => registerRowParityRule())

  const session = (sid: string, ...patches: Patch[]): ParityRecord[] =>
    compareRowGroups(input(...patches)).map((r) => ledgerRow(sid, r))

  it('named classes are explained, the rest unexplained; title and tools never gate', () => {
    const records = [
      ...session('s-1'),
      ...session('s-2', CASES[0]!.patch), // count E-HEAD
      ...session('s-3', (x) => (x.legacy!.lastPrompt = 'list the files')), // unexplained
      ...session('s-4', (x) => (x.push.title = 'Renamed')), // title: recorded only
      ...session('s-5', CASES[12]!.patch) // tools E-TAIL: recorded only
    ]
    const divs = compareRowRecords(records.filter((r) => r.sk === records[6]!.sk))
    expect(divs.map((d) => d.class)).toEqual(['count:E-HEAD'])
    const gated = rowGateRecords(records)
    expect(
      gated.every((r) => ['prompt', 'count', 'activity', 'assistant'].includes(String(r.d?.group)))
    ).toBe(true)
    const report = parityReport('row', gated)
    expect(report.sessions).toBe(5)
    expect(report.facts).toBe(20)
    expect(report.explained).toEqual({ 'count:E-HEAD': 1 })
    expect(report.unexplained).toHaveLength(1)
    expect(gateStatus(report, { minSessions: 1 }).why).toEqual(['1 unexplained'])
  })

  it('records that are not comparisons do not count as facts for the gate', () => {
    const records = [
      ...session('s-1', (x) => (x.legacy!.uuidFound = false)),
      ...session('s-2', (x) => (x.legacy = null))
    ]
    expect(rowGateRecords(records)).toEqual([])
  })

  it('a divergence record carries no text: only the group, the verdict and the class', () => {
    const records = session('s-9', CASES[2]!.patch)
    const divs = compareRowRecords(records)
    for (const d of divs) {
      expect(d.legacy).not.toMatch(/teammate-message|hello/)
      expect(d.companion).not.toMatch(/teammate-message|hello/)
    }
    expect(JSON.stringify(records)).not.toMatch(/teammate-message|hello world|list the files/)
  })
})
