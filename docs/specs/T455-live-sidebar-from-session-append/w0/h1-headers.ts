/**
 * T455 W0, A-H1: does a one-file header read taken at a `stat` hit see the same header as the read
 * the watcher's `add` leads to?
 *
 * Watches every project dir for a new top-level `<sid>.jsonl`. For each, the real reader scrapes
 * the header (`__scrapeHeaderWithStatForTests` with a fresh stat) at fixed delays after the file
 * appears:
 *   +0 ms     the earliest possible `stat` hit (the push can report the path before the file exists);
 *   +250 ms   the `add` path: chokidar's add, then the fleet model's 250 ms membership debounce;
 *   +2000 ms  the latest regular `stat` hit (main stats the claimed path at most every 2 s);
 *   +10 s     settled.
 * Compares the set-once fields (§6.6: projectPath/cwd, gitBranch, teamName, agentName) plus
 * sessionId and entrypoint (the programmatic filter) at each delay against the settled read.
 *
 * Prints aggregates only. Usage (from the repo root):
 *   npx esbuild <this file> --bundle --platform=node --format=cjs --outfile=/tmp/h1.cjs
 *   node /tmp/h1.cjs <sessions-to-collect> <timeout-seconds>
 */
import { watch, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { __scrapeHeaderWithStatForTests } from '../../../../src/main/claude-reader'

const PROJ = join(homedir(), '.claude', 'projects')
const DELAYS = [0, 250, 2000, 10_000] as const
const FIELDS = ['sessionId', 'cwd', 'gitBranch', 'teamName', 'agentName', 'entrypoint'] as const
type Field = (typeof FIELDS)[number]
type Snap = Record<Field, string> | null

const want = Number(process.argv[2] ?? 50)
const timeoutS = Number(process.argv[3] ?? 900)
const sessions = new Map<string, { snaps: Map<number, Snap>; bytes: Map<number, number> }>()
let done = 0

async function snap(path: string, delay: number): Promise<void> {
  const s = sessions.get(path)
  if (!s) return
  let st
  try {
    st = statSync(path)
  } catch {
    s.snaps.set(delay, null)
    return
  }
  s.bytes.set(delay, st.size)
  const h = await __scrapeHeaderWithStatForTests(path, st)
  s.snaps.set(
    delay,
    h
      ? (Object.fromEntries(FIELDS.map((f) => [f, String(h[f] ?? '')])) as Record<Field, string>)
      : null
  )
  if (delay === DELAYS[DELAYS.length - 1]) {
    done++
    if (done >= want) finish()
  }
}

function finish(): void {
  const settled = [...sessions.values()].filter((s) => s.snaps.has(10_000))
  const byDelay: Record<string, unknown> = {}
  for (const d of DELAYS.slice(0, -1)) {
    const diff: Record<string, number> = {}
    let nullHeader = 0
    let emptyFile = 0
    let anyDiff = 0
    for (const s of settled) {
      const a = s.snaps.get(d)
      const z = s.snaps.get(10_000)
      if ((s.bytes.get(d) ?? 0) === 0) emptyFile++
      if (!a) {
        nullHeader++
        continue
      }
      let differs = false
      for (const f of FIELDS) {
        if (z && a[f] !== z[f]) {
          diff[f] = (diff[f] ?? 0) + 1
          differs = true
        }
      }
      if (differs) anyDiff++
    }
    byDelay[`+${d}ms`] = {
      emptyFile,
      nullHeader,
      sessionsWithAnyFieldDiff: anyDiff,
      fieldDiffs: diff
    }
  }
  const diff250vs0: Record<string, number> = {}
  for (const s of settled) {
    const a = s.snaps.get(0)
    const b = s.snaps.get(250)
    if (!a || !b) continue
    for (const f of FIELDS) if (a[f] !== b[f]) diff250vs0[f] = (diff250vs0[f] ?? 0) + 1
  }
  const entry: Record<string, number> = {}
  const settledEmpty: Record<string, number> = {}
  for (const s of settled) {
    const z = s.snaps.get(10_000)
    const k = z ? z.entrypoint || '(none)' : '(null)'
    entry[k] = (entry[k] ?? 0) + 1
    for (const f of FIELDS) if (z && !z[f]) settledEmpty[f] = (settledEmpty[f] ?? 0) + 1
  }
  console.log(
    JSON.stringify(
      {
        sessions: settled.length,
        settledEntrypoint: entry,
        settledFieldEmpty: settledEmpty,
        byDelay,
        statHitVsAdd_0vs250: diff250vs0
      },
      null,
      1
    )
  )
  process.exit(0)
}

watch(PROJ, { recursive: true }, (ev, name) => {
  if (ev !== 'rename' || !name || !name.endsWith('.jsonl')) return
  const parts = name.split('/')
  if (parts.length !== 2) return // top-level transcripts only, never subagents
  const path = join(PROJ, name)
  if (sessions.has(path)) return
  try {
    statSync(path)
  } catch {
    return // a rename away, not a creation
  }
  sessions.set(path, { snaps: new Map(), bytes: new Map() })
  for (const d of DELAYS) setTimeout(() => void snap(path, d), d)
})
setTimeout(finish, timeoutS * 1000)
