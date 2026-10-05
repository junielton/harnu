import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  __testables,
  deltaTruth,
  startClaudeWatcher,
  type WatcherHandle
} from '../src/main/claude-watcher'

const { tailFile, runExclusive, makeTailState } = __testables

/**
 * T91 — the live transcript-truth the watcher rides on a `session:updated` delta.
 * Verifies the "omit what the delta can't determine" contract so a pause/switch
 * metadata re-append never downgrades the renderer's state to `unknown`.
 */
describe('deltaTruth (live turn-state / ctx% / away from a delta)', () => {
  const assistant = (stop_reason: string, extra: object = {}): object => ({
    type: 'assistant',
    uuid: 'a1',
    isSidechain: false,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      stop_reason,
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 10000,
        cache_creation_input_tokens: 20000,
        cache_read_input_tokens: 30000
      }
    },
    ...extra
  })

  it('derives idle + ctx% from an end_turn delta', () => {
    const t = deltaTruth([assistant('end_turn')])
    expect(t.transcriptState).toBe('idle')
    expect(t.ctxPct).toBe(30) // 60000 / 200000
  })

  it('derives needs-input from a trailing AskUserQuestion tool_use', () => {
    const t = deltaTruth([
      {
        type: 'assistant',
        uuid: 'a2',
        isSidechain: false,
        message: {
          role: 'assistant',
          model: 'claude-opus-4-8',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: {} }]
        }
      }
    ])
    expect(t.transcriptState).toBe('needs-input')
  })

  it('surfaces an away_summary content', () => {
    const t = deltaTruth([
      { type: 'system', uuid: 's1', subtype: 'away_summary', content: 'Goal: X. Next: Y.' }
    ])
    expect(t.awaySummary).toBe('Goal: X. Next: Y.')
  })

  it('OMITS every field for a metadata-only delta (no downgrade to unknown)', () => {
    const t = deltaTruth([
      { type: 'last-prompt', lastPrompt: 'go', sessionId: 's' },
      { type: 'custom-title', customTitle: 'Renamed', sessionId: 's' }
    ])
    expect(t).toEqual({})
    expect('transcriptState' in t).toBe(false)
    expect('ctxPct' in t).toBe(false)
  })
})

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'harnu-watch-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Write JSONL lines (each an object) to a file, returning its path. */
async function writeJsonl(name: string, objs: object[]): Promise<string> {
  const p = join(dir, name)
  await fs.writeFile(p, objs.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8')
  return p
}

describe('tailFile — normal tailing (T15/T16 baseline)', () => {
  it('a fresh file at offset 0 emits all its lines and advances to EOF', async () => {
    const p = await writeJsonl('a.jsonl', [{ n: 1 }, { n: 2 }])
    const st = makeTailState()
    const lines = await tailFile(p, st)
    expect(lines).toEqual([{ n: 1 }, { n: 2 }])
    const size = (await fs.stat(p)).size
    expect(st.offset).toBe(size)
  })

  it('a normal append tails ONLY the new lines', async () => {
    const p = await writeJsonl('a.jsonl', [{ n: 1 }])
    const st = makeTailState()
    await tailFile(p, st)
    await fs.appendFile(p, JSON.stringify({ n: 2 }) + '\n', 'utf8')
    expect(await tailFile(p, st)).toEqual([{ n: 2 }])
  })

  it('decodes a multibyte UTF-8 line intact', async () => {
    const p = await writeJsonl('a.jsonl', [{ s: 'café — ção 日本語' }])
    const st = makeTailState()
    expect(await tailFile(p, st)).toEqual([{ s: 'café — ção 日本語' }])
  })
})

describe('tailFile — capped first read (sidebar-liveness C5)', () => {
  it('for every cap, returns exactly the complete lines inside the window — no fragment, none lost', async () => {
    const objs = [{ n: 1 }, { s: 'café 日本語' }, { n: 333 }, { s: 'ção' }, { n: 5 }]
    const p = await writeJsonl('cap.jsonl', objs)
    const text = await fs.readFile(p)
    const size = text.length
    // Byte position where each line starts.
    const starts: number[] = [0]
    for (let i = 0; i < size - 1; i++) if (text[i] === 0x0a) starts.push(i + 1)
    for (let cap = 1; cap <= size + 1; cap++) {
      const st = makeTailState()
      st.firstReadCap = cap
      const got = await tailFile(p, st)
      // The window's first byte only marks a boundary: a line is kept when it
      // starts strictly after it.
      const expected = cap >= size ? objs : objs.filter((_, i) => starts[i] > size - cap)
      expect(got, `cap=${cap}`).toEqual(expected)
      expect(st.offset).toBe(size)
      expect(__testables.lastTailBytesForTests(p)).toBe(Math.min(cap, size))
    }
  })

  it('applies only to the first read; later appends tail normally', async () => {
    const p = await writeJsonl('cap2.jsonl', [{ n: 1 }, { n: 2 }])
    const st = makeTailState()
    st.firstReadCap = 8 // '{"n":2}\n' is 8 bytes; its start is not after the window's first byte
    expect(await tailFile(p, st)).toEqual([])
    await fs.appendFile(p, JSON.stringify({ n: 3 }) + '\n', 'utf8')
    expect(await tailFile(p, st)).toEqual([{ n: 3 }])
  })
})

describe('tailFile — compaction rewrite (T16)', () => {
  it('re-baselines on shrink WITHOUT re-emitting the whole file', async () => {
    const p = await writeJsonl('a.jsonl', [{ n: 1 }, { n: 2 }, { n: 3 }])
    const st = makeTailState()
    await tailFile(p, st) // consume to EOF

    // Simulate `/compact`: rewrite the file much shorter, same inode.
    await fs.writeFile(p, JSON.stringify({ summary: 'compacted' }) + '\n', 'utf8')
    const newSize = (await fs.stat(p)).size
    expect(await tailFile(p, st)).toEqual([]) // NOT the whole compacted file
    expect(st.offset).toBe(newSize)

    // A subsequent append tails only the genuinely-new line.
    await fs.appendFile(p, JSON.stringify({ n: 99 }) + '\n', 'utf8')
    expect(await tailFile(p, st)).toEqual([{ n: 99 }])
  })

  it('re-baselines on an atomic replace even when size grew (inode change)', async () => {
    const p = await writeJsonl('a.jsonl', [{ n: 1 }])
    const st = makeTailState()
    await tailFile(p, st) // adopts the original inode

    // Atomic replace with LARGER, different content (write-temp + rename → new inode).
    const tmp = join(dir, 'a.jsonl.tmp')
    await fs.writeFile(
      tmp,
      [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }].map((o) => JSON.stringify(o)).join('\n') + '\n',
      'utf8'
    )
    await fs.rename(tmp, p)
    const newSize = (await fs.stat(p)).size
    expect(await tailFile(p, st)).toEqual([]) // size grew but content is a rewrite → no replay
    expect(st.offset).toBe(newSize)

    await fs.appendFile(p, JSON.stringify({ x: 5 }) + '\n', 'utf8')
    expect(await tailFile(p, st)).toEqual([{ x: 5 }])
  })

  it('does NOT suppress a brand-new file (offset 0 always emits)', async () => {
    const p = await writeJsonl('a.jsonl', [{ n: 1 }, { n: 2 }])
    // offset 0 + no prior ino → the rewrite guard is off; initial lines emit.
    expect(await tailFile(p, makeTailState())).toEqual([{ n: 1 }, { n: 2 }])
  })
})

describe('runExclusive — per-path serialization (T15)', () => {
  it('serializes concurrent tails on one TailState: each line emitted exactly once', async () => {
    const p = await writeJsonl('a.jsonl', [{ n: 1 }, { n: 2 }, { n: 3 }])
    const st = makeTailState()
    const chains = new Map<string, Promise<unknown>>()

    // Fire two tails concurrently against the SAME state (the add/change race).
    const [a, b] = await Promise.all([
      runExclusive(chains, p, () => tailFile(p, st)),
      runExclusive(chains, p, () => tailFile(p, st))
    ])

    // Serialized: the first tail consumed everything; the second saw only EOF.
    const all = [...(a as object[]), ...(b as object[])]
    expect(all).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]) // no duplicates
    expect(st.offset).toBe((await fs.stat(p)).size)
  })

  it('runs tasks FIFO so the second sees the offset the first left', async () => {
    const p = await writeJsonl('a.jsonl', [{ n: 1 }])
    const st = makeTailState()
    const chains = new Map<string, Promise<unknown>>()
    const order: string[] = []

    const first = runExclusive(chains, p, async () => {
      await tailFile(p, st)
      order.push('first')
    })
    const second = runExclusive(chains, p, async () => {
      order.push(`second@${st.offset}`)
    })
    await Promise.all([first, second])

    expect(order[0]).toBe('first')
    expect(order[1]).toBe(`second@${(await fs.stat(p)).size}`) // sees first's advance
  })

  it('self-cleans the chain map when idle', async () => {
    const p = await writeJsonl('a.jsonl', [{ n: 1 }])
    const chains = new Map<string, Promise<unknown>>()
    await runExclusive(chains, p, () => tailFile(p, makeTailState()))
    // microtask for the .finally cleanup
    await Promise.resolve()
    expect(chains.size).toBe(0)
  })
})

/**
 * BUG-55 — real chokidar against a tmpdir root (the shell the rest of this
 * file's tests deliberately bypass). Covers AC2 (a slug dir created after
 * `ready` is picked up) and AC4 (an add/unlink pair correlating a cross-slug
 * move is order-independent — neither ordering leaks a spurious
 * `claude:session:removed` for a session that only moved).
 */
describe('startClaudeWatcher — cross-slug moves + post-ready dirs (e2e chokidar, BUG-55)', () => {
  let root: string
  let handle: WatcherHandle | null
  let events: Array<{ channel: string; payload: unknown }>

  function fakeWindow(): import('electron').BrowserWindow {
    return {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          events.push({ channel, payload })
        }
      }
    } as unknown as import('electron').BrowserWindow
  }

  async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
    const start = Date.now()
    while (!pred()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for condition; events so far: ${JSON.stringify(events)}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-watch-root-'))
    events = []
    handle = null
  })

  afterEach(async () => {
    await handle?.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('a slug dir created after ready emits project:added, and a JSONL inside it emits session:added (AC2)', async () => {
    let ready = false
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      }
    })
    await waitFor(() => ready)

    const slugDir = join(root, 'new-worktree-slug')
    await fs.mkdir(slugDir)
    await waitFor(() => events.some((e) => e.channel === 'claude:project:added'))
    expect(events.find((e) => e.channel === 'claude:project:added')).toMatchObject({
      payload: { slug: 'new-worktree-slug' }
    })

    await fs.writeFile(join(slugDir, 'sess-1.jsonl'), JSON.stringify({ n: 1 }) + '\n', 'utf8')
    await waitFor(() => events.some((e) => e.channel === 'claude:session:added'))
    expect(events.find((e) => e.channel === 'claude:session:added')).toMatchObject({
      payload: { slug: 'new-worktree-slug', sessionId: 'sess-1' }
    })
  }, 10000)

  it('AC-2: a slug dir created after ready schedules a model refresh via onSlugChanged', async () => {
    let ready = false
    const slugs: string[] = []
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      },
      onSlugChanged: (s) => slugs.push(s)
    })
    await waitFor(() => ready)
    await fs.mkdir(join(root, 'brand-new-slug'))
    await waitFor(() => events.some((e) => e.channel === 'claude:project:added'))
    expect(slugs).toContain('brand-new-slug')
  }, 10000)

  it('add-then-unlink: a session re-added under a new slug is not later ghost-removed when the old file is unlinked (AC4)', async () => {
    const oldSlugDir = join(root, 'old-slug')
    await fs.mkdir(oldSlugDir, { recursive: true })
    const oldPath = join(oldSlugDir, 'sess-move.jsonl')
    await fs.writeFile(oldPath, JSON.stringify({ n: 1 }) + '\n', 'utf8')

    let ready = false
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      }
    })
    await waitFor(() => ready)

    const newSlugDir = join(root, 'new-slug')
    await fs.mkdir(newSlugDir)
    await fs.copyFile(oldPath, join(newSlugDir, 'sess-move.jsonl'))
    await waitFor(() =>
      events.some(
        (e) =>
          e.channel === 'claude:session:added' &&
          (e.payload as { slug?: string }).slug === 'new-slug'
      )
    )

    await fs.rm(oldPath)
    // Give the unlink's grace window (and then some) to elapse.
    await new Promise((r) => setTimeout(r, 600))

    expect(events.some((e) => e.channel === 'claude:session:removed')).toBe(false)
  }, 10000)

  it('unlink-then-add: an old-slug unlink that races ahead of the new-slug add is still a no-op (AC4, reverse order)', async () => {
    const oldSlugDir = join(root, 'old-slug')
    await fs.mkdir(oldSlugDir, { recursive: true })
    const oldPath = join(oldSlugDir, 'sess-move2.jsonl')
    await fs.writeFile(oldPath, JSON.stringify({ n: 1 }) + '\n', 'utf8')

    let ready = false
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      }
    })
    await waitFor(() => ready)

    // Unlink fires FIRST, before the new-slug add — the adversarial ordering.
    await fs.rm(oldPath)
    const newSlugDir = join(root, 'new-slug2')
    await fs.mkdir(newSlugDir)
    await fs.writeFile(
      join(newSlugDir, 'sess-move2.jsonl'),
      JSON.stringify({ n: 1 }) + '\n',
      'utf8'
    )

    await waitFor(() =>
      events.some(
        (e) =>
          e.channel === 'claude:session:added' &&
          (e.payload as { slug?: string }).slug === 'new-slug2'
      )
    )
    await new Promise((r) => setTimeout(r, 600))

    expect(events.some((e) => e.channel === 'claude:session:removed')).toBe(false)
  }, 10000)

  // BUG-77 — Harnu runs `claude -p` itself (the /usage poller, the Haiku
  // auto-namer, usage-history chat) with `cwd: homedir()`, so those transcripts
  // land in a watched slug. They must never be announced as sessions: the
  // renderer's synth→real collapse picks the newest synthetic in the folder by
  // recency, so a probe landing next to a "+ New session" steals its identity
  // and its live terminal.
  it('a programmatic (sdk-cli) transcript is never announced as a session (BUG-77)', async () => {
    const slugDir = join(root, 'home-slug')
    await fs.mkdir(slugDir, { recursive: true })

    let ready = false
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      }
    })
    await waitFor(() => ready)

    // A `/usage` poll, written the way Claude Code writes one.
    await fs.writeFile(
      join(slugDir, 'probe-1.jsonl'),
      [
        JSON.stringify({ type: 'queue-operation', sessionId: 'probe-1' }),
        JSON.stringify({ type: 'attachment', entrypoint: 'sdk-cli', cwd: '/home/u' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: '/usage' } })
      ].join('\n') + '\n',
      'utf8'
    )
    // A real interactive session in the same slug, written right after.
    await fs.writeFile(
      join(slugDir, 'real-1.jsonl'),
      [
        JSON.stringify({ type: 'queue-operation', sessionId: 'real-1' }),
        JSON.stringify({ type: 'attachment', entrypoint: 'cli', cwd: '/home/u' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })
      ].join('\n') + '\n',
      'utf8'
    )

    await waitFor(() =>
      events.some(
        (e) =>
          e.channel === 'claude:session:added' &&
          (e.payload as { sessionId?: string }).sessionId === 'real-1'
      )
    )
    // Give the probe every chance to be announced late.
    await new Promise((r) => setTimeout(r, 400))

    const announced = events
      .filter((e) => e.channel === 'claude:session:added')
      .map((e) => (e.payload as { sessionId?: string }).sessionId)
    expect(announced).toContain('real-1')
    expect(announced).not.toContain('probe-1')

    // …and its content never reaches the renderer either, so the row label can
    // never be backfilled from the probe's transcript.
    const updated = events
      .filter((e) => e.channel === 'claude:session:updated')
      .map((e) => (e.payload as { sessionId?: string }).sessionId)
    expect(updated).not.toContain('probe-1')
  }, 10000)

  it('appending to a programmatic transcript stays silent (BUG-77)', async () => {
    const slugDir = join(root, 'home-slug2')
    await fs.mkdir(slugDir, { recursive: true })

    let ready = false
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      }
    })
    await waitFor(() => ready)

    const probe = join(slugDir, 'probe-2.jsonl')
    await fs.writeFile(
      probe,
      JSON.stringify({ type: 'attachment', entrypoint: 'sdk-cli' }) + '\n',
      'utf8'
    )
    await new Promise((r) => setTimeout(r, 250))
    await fs.appendFile(
      probe,
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }) + '\n',
      'utf8'
    )
    await new Promise((r) => setTimeout(r, 400))

    expect(
      events.some(
        (e) =>
          (e.channel === 'claude:session:added' || e.channel === 'claude:session:updated') &&
          (e.payload as { sessionId?: string }).sessionId === 'probe-2'
      )
    ).toBe(false)
  }, 10000)

  it('AC-22: a first append to a pre-existing 5 MB transcript tails ≤ 256 KB', async () => {
    const slugDir = join(root, 'big-slug')
    await fs.mkdir(slugDir, { recursive: true })
    const p = join(slugDir, 'big.jsonl')
    const head = JSON.stringify({
      type: 'user',
      entrypoint: 'cli',
      message: { role: 'user', content: 'hi' }
    })
    const filler = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'y'.repeat(4000) }] }
    })
    await fs.writeFile(
      p,
      head + '\n' + Array.from({ length: 1300 }, () => filler).join('\n') + '\n'
    )
    let ready = false
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      }
    })
    await waitFor(() => ready)
    await fs.appendFile(
      p,
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'new' }] } }) +
        '\n'
    )
    await waitFor(() => events.some((e) => e.channel === 'claude:session:updated'))
    expect(__testables.lastTailBytesForTests(p)).toBeLessThanOrEqual(256 * 1024)
    // The pre-existing first prompt still reaches the row (read from the head).
    const update = events.find((e) => e.channel === 'claude:session:updated')!
    expect(update.payload).toMatchObject({ sessionId: 'big', firstPromptCandidate: 'hi' })
  }, 15000)

  it('AC-22: a claude -p transcript first seen via change is classified from the 8 KB head even when the tail has no entrypoint', async () => {
    const slugDir = join(root, 'probe-slug')
    await fs.mkdir(slugDir, { recursive: true })
    const p = join(slugDir, 'probe.jsonl')
    const head = JSON.stringify({
      type: 'user',
      entrypoint: 'sdk-cli',
      message: { role: 'user', content: 'probe' }
    })
    const filler = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'z'.repeat(4000) }] }
    })
    await fs.writeFile(p, head + '\n' + Array.from({ length: 200 }, () => filler).join('\n') + '\n')
    const slugs: string[] = []
    let ready = false
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      },
      onSlugChanged: (s) => slugs.push(s)
    })
    await waitFor(() => ready)
    await fs.appendFile(p, filler + '\n')
    await new Promise((r) => setTimeout(r, 800))
    expect(events.some((e) => e.channel === 'claude:session:updated')).toBe(false)
    expect(slugs).not.toContain('probe-slug')
  }, 15000)

  it('AC-22: a missed subagent add keeps its head metadata under the tail cap', async () => {
    const subDir = join(root, 'sub-slug', 'parent-1', 'subagents')
    await fs.mkdir(subDir, { recursive: true })
    const p = join(subDir, 'agent-a1.jsonl')
    const head = JSON.stringify({
      type: 'user',
      attributionAgent: 'general-purpose',
      message: { role: 'user', content: 'the task' }
    })
    const filler = JSON.stringify({
      type: 'assistant',
      message: { model: 'm1', content: [{ type: 'text', text: 'w'.repeat(4000) }] }
    })
    await fs.writeFile(p, head + '\n' + Array.from({ length: 200 }, () => filler).join('\n') + '\n')
    let ready = false
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      }
    })
    await waitFor(() => ready)
    await fs.appendFile(p, filler + '\n')
    await waitFor(() => events.some((e) => e.channel === 'claude:subagent:updated'))
    expect(__testables.lastTailBytesForTests(p)).toBeLessThanOrEqual(256 * 1024)
    expect(events.find((e) => e.channel === 'claude:subagent:updated')!.payload).toMatchObject({
      parentSessionId: 'parent-1',
      agentId: 'a1',
      meta: { agentType: 'general-purpose', task: 'the task', model: 'm1' }
    })
  }, 15000)

  it('AC-27: a change queued while the add is classifying a claude -p transcript emits nothing (BUG-77 race)', async () => {
    const slugDir = join(root, 'race-slug')
    await fs.mkdir(slugDir, { recursive: true })
    const p = join(slugDir, 'probe-race.jsonl')
    // Hold the `add` between its first read and its classification, so the
    // append below is guaranteed to queue a `change` behind it on the path chain.
    let release: () => void = () => {}
    let gated = false
    __testables.setClassifyGateForTests(async (gatePath) => {
      if (gatePath !== p) return
      gated = true
      await new Promise<void>((r) => {
        release = r
      })
    })
    try {
      const slugs: string[] = []
      let ready = false
      handle = await startClaudeWatcher(() => fakeWindow(), {
        rootDir: root,
        skipSeed: true,
        onReady: () => {
          ready = true
        },
        onSlugChanged: (s) => slugs.push(s)
      })
      await waitFor(() => ready)
      await fs.writeFile(p, JSON.stringify({ type: 'attachment', entrypoint: 'sdk-cli' }) + '\n')
      await waitFor(() => gated)
      await fs.appendFile(
        p,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }) + '\n'
      )
      await new Promise((r) => setTimeout(r, 300)) // chokidar emits the change meanwhile
      release()
      await new Promise((r) => setTimeout(r, 800))
      expect(
        events.some(
          (e) =>
            (e.channel === 'claude:session:added' || e.channel === 'claude:session:updated') &&
            (e.payload as { sessionId?: string }).sessionId === 'probe-race'
        )
      ).toBe(false)
      expect(slugs).not.toContain('race-slug')
    } finally {
      release()
      __testables.setClassifyGateForTests(null)
    }
  }, 15000)

  it('AC-17: a session add notifies as membership; a later append to it notifies as append', async () => {
    const slugDir = join(root, 'cadence-slug')
    await fs.mkdir(slugDir, { recursive: true })
    let ready = false
    const calls: Array<[string, string | undefined]> = []
    handle = await startClaudeWatcher(() => fakeWindow(), {
      rootDir: root,
      skipSeed: true,
      onReady: () => {
        ready = true
      },
      onSlugChanged: (s, cls) => calls.push([s, cls])
    })
    await waitFor(() => ready)
    const p = join(slugDir, 'sess-c.jsonl')
    await fs.writeFile(p, JSON.stringify({ n: 1 }) + '\n', 'utf8')
    await waitFor(() => events.some((e) => e.channel === 'claude:session:added'))
    expect(calls).toContainEqual(['cadence-slug', 'membership'])
    await fs.appendFile(p, JSON.stringify({ n: 2 }) + '\n', 'utf8')
    await waitFor(() => calls.some(([, cls]) => cls === 'append'))
    expect(calls.filter(([, cls]) => cls === 'append').every(([s]) => s === 'cadence-slug')).toBe(
      true
    )
  }, 10000)
})

describe('classifyTranscriptLines (BUG-77 — programmatic vs interactive transcript)', () => {
  const { classifyTranscriptLines } = __testables

  it('reads the first line that carries an entrypoint', () => {
    expect(classifyTranscriptLines([{ type: 'attachment', entrypoint: 'cli' }])).toBe('interactive')
    expect(classifyTranscriptLines([{ type: 'attachment', entrypoint: 'sdk-cli' }])).toBe(
      'programmatic'
    )
    expect(classifyTranscriptLines([{ type: 'attachment', entrypoint: 'sdk-py' }])).toBe(
      'programmatic'
    )
  })

  it('skips lines with no entrypoint until one carries it', () => {
    expect(
      classifyTranscriptLines([
        { type: 'queue-operation' },
        { type: 'attachment' },
        { type: 'attachment', entrypoint: 'sdk-cli' }
      ])
    ).toBe('programmatic')
  })

  it('returns null when nothing carries an entrypoint — never guesses', () => {
    expect(classifyTranscriptLines([])).toBeNull()
    expect(classifyTranscriptLines([{ type: 'user' }, { n: 1 }])).toBeNull()
  })

  it('ignores non-object and non-string-entrypoint lines', () => {
    expect(classifyTranscriptLines([null, 42, 'x', { entrypoint: 7 }])).toBeNull()
  })
})
