// Time-to-row: simulate a `claude` session started OUTSIDE Harnu and time how long
// until the isolated instance's sessions store (and the visible sidebar) shows it.
// usage: node ttr.mjs <scenario> <cwd> [timeoutS]
//   existing-slug | new-slug   (cwd = the session's working directory)
//   worktree <repo> <wtPath>   (git worktree add, no session — T388)
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { connect, pageTarget, sleep } from './cdp.mjs'
import { PAGE_PORT } from './procs.mjs'

const [scenario, a1, a2, a3] = process.argv.slice(2)
const FH = process.env.FH
if (!FH) throw new Error('FH (the isolated instance fake HOME) must be set')
const page = await connect((await pageTarget(PAGE_PORT)).webSocketDebuggerUrl)
await page.send('Runtime.enable')
const STORE = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('sessions')`
const flat = (v) =>
  `(function f(xs){ const o=[]; for (const x of xs) { if (x.kind === 'folder-group') o.push(...f(x.folders)); else o.push(x) } return o })(${v})`

const slugOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-')
const line = (sid, cwd, o) =>
  JSON.stringify({
    sessionId: sid,
    cwd,
    entrypoint: 'cli',
    version: '2.1.287',
    gitBranch: 'main',
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    ...o
  }) + '\n'

async function waitFor(expr, timeoutS, onTick) {
  const t0 = Date.now()
  let n = 0
  while (Date.now() - t0 < timeoutS * 1000) {
    if (await page.evaluate(expr)) return Date.now() - t0
    await sleep(50)
    if (onTick && ++n % 40 === 0) onTick() // every ~2 s
  }
  return null
}

if (scenario === 'existing-slug' || scenario === 'new-slug') {
  const cwd = a1
  const timeoutS = Number(a2 ?? 30)
  const dir = `${FH}/.claude/projects/${slugOf(cwd)}`
  const existed = existsSync(dir)
  mkdirSync(dir, { recursive: true })
  const sid = randomUUID()
  const file = `${dir}/${sid}.jsonl`
  const t0 = Date.now()
  // Claude Code's creation burst: metadata lines, then the first user turn.
  appendFileSync(
    file,
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: sid }) +
      '\n' +
      line(sid, cwd, {
        type: 'user',
        message: { role: 'user', content: 'liveness probe ' + sid.slice(0, 8) }
      })
  )
  let appends = 0
  const keepAppending = () => {
    appends++
    appendFileSync(
      file,
      line(sid, cwd, {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'x',
          content: [{ type: 'text', text: 'tick ' + appends }]
        }
      })
    )
  }
  const inStore = `${STORE}.allSessions.some((s) => s.sessionId === '${sid}')`
  const inSidebar = `${flat(`${STORE}.visibleFolders`)}.some((f) => f.sessions.some((s) => s.sessionId === '${sid}'))`
  const tStore = await waitFor(inStore, timeoutS, keepAppending)
  const tSide = tStore == null ? null : (await waitFor(inSidebar, 5)) + tStore
  console.log(
    JSON.stringify({
      scenario,
      slugExisted: existed,
      sid,
      msToStore: tStore,
      msToSidebar: tSide,
      appendsWhileWaiting: appends,
      wallMs: Date.now() - t0
    })
  )
} else if (scenario === 'worktree') {
  const [repo, wt, timeoutS = '30'] = [a1, a2, a3]
  const t0 = Date.now()
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'liveness-' + Date.now(), wt])
  const inStore = `${STORE}.folders.some((f) => f.path === '${wt}')`
  const tStore = await waitFor(inStore, Number(timeoutS))
  console.log(JSON.stringify({ scenario, wt, msToStore: tStore, wallMs: Date.now() - t0 }))
}
page.close()
process.exit(0)
