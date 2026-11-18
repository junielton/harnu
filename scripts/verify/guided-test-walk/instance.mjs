/**
 * The throwaway second instance the guided walk smoke test drives (docs/dev/live-verify-second-instance.md).
 *
 * What it builds, all under one short run directory `/tmp/hv-walk-<id>`:
 *  - its own `HOME` and XDG dirs and its own `--user-data-dir`, so nothing of the operator's is read or written;
 *  - a stub `claude` that appends every line it receives to a file and otherwise sleeps, and a stub `gh` that
 *    answers one question (a PR number to its address), so no real Claude or GitHub is ever called;
 *  - a throwaway repo (`example-web`) with a second worktree, a second repo with no walks, a local http page;
 *  - the freshly built renderer served on a free port, the main process under xvfb with a free CDP port.
 *
 * It stops only the PIDs it started (a ledger of its own process group), never a `pkill` pattern.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { assertInstanceIsolated, instanceEnv } from '../../eval/mission-behavior/harnu.mjs'
import { createLedger, escalate, groupTarget } from '../../eval/mission-behavior/procs.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** `{ relative path -> sha256 }` of every regular file under `dir` (empty when it does not exist). */
export function hashTree(dir) {
  const out = {}
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out[path.relative(dir, p)] = sha256(p)
    }
  }
  walk(dir)
  return out
}

export function diffHashes(before, after) {
  const changed = Object.keys(before).filter((k) => k in after && before[k] !== after[k])
  const vanished = Object.keys(before).filter((k) => !(k in after))
  const appeared = Object.keys(after).filter((k) => !(k in before))
  return {
    changed,
    vanished,
    appeared,
    same: !changed.length && !vanished.length && !appeared.length
  }
}

/** A solid-colour PNG (`size` x `size`), written without any image library. */
export function makePng(size, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([r, g, b]).flat())])
  const raw = Buffer.concat(Array(size).fill(row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

async function serveStatic(root) {
  const port = await freePort()
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = path.join(root, urlPath === '/' ? 'index.html' : urlPath)
    if (!file.startsWith(root)) return void res.writeHead(403).end()
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html')
    try {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
      res.end(readFileSync(file))
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

/** The local page the sample walk's `url` link opens. */
async function servePreview(runDir) {
  const port = await freePort()
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/notes') {
      appendFileSync(path.join(runDir, 'preview-hits.log'), `${req.method} ${req.url}\n`)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>Notes preview</title><h1>Notes preview</h1><p>Milk run</p>')
    } else res.writeHead(404).end()
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${port}/notes`, close: () => new Promise((r) => server.close(r)) }
}

/** Every instance this run launched, so a crash or Ctrl-C stops exactly those and nothing else. */
const launched = new Set()

export async function killLaunched() {
  const targets = []
  for (const inst of launched) {
    inst.ledger.snapshot()
    targets.push(groupTarget(inst.pgid), ...inst.ledger.alive().map((e) => inst.ledger.target(e)))
  }
  launched.clear()
  return escalate(targets)
}

function launch(cmd, args, { env, cwd, logFile }) {
  const useXvfb =
    process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v xvfb-run']).status === 0
  const [bin, binArgs] = useXvfb
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', cmd, ...args]]
    : [cmd, args]
  const out = createWriteStream(logFile, { flags: 'a' })
  const child = spawn(bin, binArgs, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  const ledger = createLedger()
  ledger.trackRoot(child.pid)
  const timer = setInterval(() => ledger.snapshot(), 1000)
  timer.unref()
  const reg = { pgid: child.pid, ledger }
  launched.add(reg)
  return {
    child,
    ledger,
    pids: () => {
      ledger.snapshot()
      return ledger.alive().map((e) => e.pid)
    },
    async stop() {
      clearInterval(timer)
      ledger.snapshot()
      const res = await escalate([
        groupTarget(child.pid),
        ...ledger.alive().map((e) => ledger.target(e))
      ])
      launched.delete(reg)
      return res
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------------------------------------

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  Tab: { code: 'Tab', vk: 9 }
}

export async function connectCdp(port, timeoutMs = 90_000) {
  const started = Date.now()
  let wsUrl = null
  while (!wsUrl) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      wsUrl = t.find((x) => x.type === 'page')?.webSocketDebuggerUrl ?? null
    } catch {
      /* not up yet */
    }
    if (!wsUrl) {
      if (Date.now() - started > timeoutMs) throw new Error('CDP target did not come up')
      await sleep(500)
    }
  }
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP websocket error'))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 30_000)
      pending.set(i, (d) => {
        clearTimeout(timer)
        d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result)
      })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Page.enable')
  await send('Runtime.enable')
  // the window under xvfb is not focused: a page that is not "focused" refuses clipboard reads
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront').catch(() => {})

  const cdp = {
    send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      })
      if (r.exceptionDetails) {
        throw new Error(
          `page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`
        )
      }
      return r.result.value
    },
    async waitFor(expr, ms = 20_000, what = expr) {
      const t0 = Date.now()
      for (;;) {
        const v = await cdp.eval(expr).catch(() => null)
        if (v) return v
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
        await sleep(150)
      }
    },
    /** Wait until the page really paints (requestAnimationFrame fires): a fresh window can stall for a while. */
    async waitPainting(ms = 60_000) {
      const t0 = Date.now()
      for (;;) {
        await send('Page.bringToFront').catch(() => {})
        const ok = await cdp
          .eval(
            `new Promise((res) => { const t = setTimeout(() => res(false), 2500); requestAnimationFrame(() => { clearTimeout(t); res(true) }) })`
          )
          .catch(() => false)
        if (ok) return
        if (Date.now() - t0 > ms)
          throw new Error('the page does not paint (requestAnimationFrame never fires)')
        await sleep(500)
      }
    },
    /** The centre of the first element matching `sel` (optionally the one whose text matches `text`). */
    async centre(sel, text = null) {
      const c = await cdp.eval(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
        const el = ${text === null ? 'els[0]' : `els.find((e) => (e.textContent || '').includes(${JSON.stringify(text)}))`}
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'center' })
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        const top = document.elementFromPoint(x, y)
        const hit = !!top && (top === el || el.contains(top) || top.contains(el))
        return { x, y, w: r.width, h: r.height, hit, over: hit ? null : (top?.tagName ?? '?') + '.' + String(top?.className ?? '').slice(0, 40) }
      })()`)
      return c
    },
    /** A trusted mouse click (user activation, so the clipboard accepts it). */
    async click(sel, text = null) {
      // a terminal that is still being resized after the pane opened can sit on top for a moment: wait it out
      let c = null
      for (let i = 0; i < 25; i++) {
        c = await cdp.centre(sel, text)
        if (c && c.w > 0 && c.hit) break
        await sleep(200)
      }
      if (!c || c.w === 0) throw new Error(`nothing to click for ${sel}${text ? ` / ${text}` : ''}`)
      if (!c.hit) throw new Error(`${sel}${text ? ` / ${text}` : ''} is covered by ${c.over}`)
      const base = { x: c.x, y: c.y, button: 'left', clickCount: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
      await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
      await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    },
    /** A trusted key press (`Enter`, `Escape`, or one character). */
    async key(name, { modifiers = 0 } = {}) {
      const k = KEYS[name] ?? {
        code: name.length === 1 ? `Key${name.toUpperCase()}` : name,
        vk: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0,
        text: name.length === 1 ? name : undefined
      }
      const base = {
        key: name,
        code: k.code,
        windowsVirtualKeyCode: k.vk,
        nativeVirtualKeyCode: k.vk,
        modifiers
      }
      await send('Input.dispatchKeyEvent', {
        ...base,
        type: k.text !== undefined && !modifiers ? 'keyDown' : 'rawKeyDown',
        ...(k.text !== undefined && !modifiers ? { text: k.text } : {})
      })
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
    },
    /** A trusted right click (opens a context menu). */
    async rightClick(sel, text = null) {
      let c = null
      for (let i = 0; i < 25; i++) {
        c = await cdp.centre(sel, text)
        if (c && c.w > 0 && c.hit) break
        await sleep(200)
      }
      if (!c || !c.hit) throw new Error(`cannot right-click ${sel}`)
      const base = { x: c.x, y: c.y, button: 'right', buttons: 2, clickCount: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
      await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
      await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    },
    async type(text) {
      await send('Input.insertText', { text })
    },
    async shot(file) {
      await send('Page.bringToFront').catch(() => {})
      const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      writeFileSync(file, Buffer.from(r.data, 'base64'))
    },
    /** Make the page see a window of this size (the layout answers to it). `null` clears it. */
    async viewport(width, height) {
      if (width === null) await send('Emulation.clearDeviceMetricsOverride')
      else
        await send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false
        })
    },
    close: () => ws.close()
  }
  return cdp
}

// ---------------------------------------------------------------------------------------------------------
// MCP (the control server's own transport, as an agent would call it)
// ---------------------------------------------------------------------------------------------------------

export async function connectMcp(userData, timeoutMs = 120_000, child = null) {
  const cfg = path.join(userData, 'harnu.mcp.json')
  const started = Date.now()
  while (!existsSync(cfg)) {
    if (child && child.exitCode !== null)
      throw new Error(`instance exited early (${child.exitCode})`)
    if (Date.now() - started > timeoutMs) throw new Error('MCP server did not come up')
    await sleep(500)
  }
  const server = JSON.parse(readFileSync(cfg, 'utf8')).mcpServers.harnu
  const client = new Client({ name: 'guided-test-walk', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers }
    })
  )
  return {
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
      const text = res.content?.[0]?.text ?? ''
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { raw: text }
      }
      return { isError: res.isError === true, payload }
    },
    close: () => client.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------------------------------------
// Fixtures: transcripts, repos
// ---------------------------------------------------------------------------------------------------------

const slugOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-')

/** A Claude-shaped transcript so the sidebar knows the session (the instance starts no real Claude). */
function writeTranscript(home, cwd, sessionId, text) {
  const dir = path.join(home, '.claude', 'projects', slugOf(cwd))
  mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString()
  const line = (type, message) =>
    JSON.stringify({
      type,
      sessionId,
      cwd,
      entrypoint: 'cli',
      gitBranch: 'main',
      timestamp: ts,
      uuid: `${type}-${sessionId}`,
      message
    })
  writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    [
      line('user', { role: 'user', content: text }),
      line('assistant', {
        role: 'assistant',
        model: 'm',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: 'ok' }]
      })
    ].join('\n') + '\n'
  )
}

const git = (cwd, ...a) =>
  execFileSync(
    'git',
    ['-c', 'user.name=walk-smoke', '-c', 'user.email=walk@example.invalid', ...a],
    {
      cwd,
      stdio: 'ignore'
    }
  )

/** Where the files of the stub `claude` and `gh` are written. */
function writeStubs(bin, stubLog) {
  mkdirSync(bin, { recursive: true })
  // Records its own arguments and pid, then every line it receives; never answers, never calls anything.
  writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh
printf 'START pid=%s %s\\n' "$$" "$*" >> '${stubLog}'
while IFS= read -r line; do printf '%s\\n' "$line" >> '${stubLog}'; done
exec sleep 3600
`
  )
  // Answers the one question the walk pane asks of gh: a PR number to its address.
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "https://prs.example.invalid/example-org/example-web/pull/$3"
  exit 0
fi
exit 1
`
  )
  chmodSync(path.join(bin, 'claude'), 0o755)
  chmodSync(path.join(bin, 'gh'), 0o755)
}

// ---------------------------------------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------------------------------------

export const SESSIONS = {
  owner: '5e5e5e5e-0000-4000-8000-000000000001',
  other: '5e5e5e5e-0000-4000-8000-000000000002',
  leader: '5e5e5e5e-0000-4000-8000-000000000003'
}

/**
 * Build the sandbox and start the app in it.
 * @param {{ repoRoot: string, id: string, fixtures: string, env?: Record<string,string> }} o
 */
export async function startInstance({ repoRoot, id, fixtures, env: extraEnv = {} }) {
  const runDir = `/tmp/hv-walk-${id}`
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  const realHome = process.env.HOME ?? os.homedir()
  const userData = path.join(runDir, 'u')
  const stubLog = path.join(runDir, 'stub.log')
  writeFileSync(stubLog, '')

  // repos: example-web (main checkout) with a second worktree, and one with no walks at all
  const repo = path.join(runDir, 'example-web')
  cpSync(path.join(fixtures, 'repo'), repo, { recursive: true })
  mkdirSync(path.join(repo, 'docs', 'shots'), { recursive: true })
  writeFileSync(
    path.join(repo, 'docs', 'shots', 'search-expected.png'),
    makePng(24, [70, 120, 200])
  )
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const repoB = path.join(runDir, 'example-web-b')
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/notes-search', repoB)
  const repoEmpty = path.join(runDir, 'example-empty')
  mkdirSync(repoEmpty)
  git(repoEmpty, 'init', '-q', '-b', 'main')
  git(repoEmpty, 'commit', '-q', '--allow-empty', '-m', 'init')

  const preview = await servePreview(runDir)
  const renderer = await serveStatic(path.join(repoRoot, 'out', 'renderer'))
  const cdpPort = await freePort()
  const env = instanceEnv({ runDir, rendererUrl: renderer.url })
  Object.assign(env, extraEnv)
  assertInstanceIsolated(env, realHome, runDir)
  mkdirSync(env.HOME, { recursive: true })
  const bin = path.join(runDir, 'bin')
  writeStubs(bin, stubLog)
  env.PATH = `${bin}:${env.PATH}`
  writeTranscript(env.HOME, repo, SESSIONS.owner, 'walk smoke: the session that owns the walks')
  writeTranscript(env.HOME, repoB, SESSIONS.other, 'walk smoke: a session of the second worktree')
  writeTranscript(env.HOME, repo, SESSIONS.leader, 'walk smoke: the leader of the mission')

  const inst = {
    runDir,
    userData,
    repo,
    repoB,
    repoEmpty,
    stubLog,
    preview: preview.url,
    cdpPort,
    env,
    sessions: SESSIONS,
    cdp: null,
    mcp: null,
    proc: null,
    realHome
  }

  /** Start (or restart, on the same user-data-dir) the app and connect CDP and MCP. */
  inst.boot = async () => {
    rmSync(path.join(userData, 'harnu.mcp.json'), { force: true })
    inst.proc = launch(
      path.join(repoRoot, 'node_modules', '.bin', 'electron'),
      [
        path.join(repoRoot, 'out', 'main', 'index.js'),
        `--user-data-dir=${userData}`,
        `--remote-debugging-port=${cdpPort}`,
        '--no-sandbox',
        // a window under xvfb can be treated as hidden and stop painting (requestAnimationFrame never fires, a
        // screenshot hangs): keep it a foreground window
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling'
      ],
      { env, cwd: repoRoot, logFile: path.join(runDir, 'instance.log') }
    )
    inst.mcp = await connectMcp(userData, 120_000, inst.proc.child)
    inst.cdp = await connectCdp(cdpPort)
    await inst.cdp.waitFor(`typeof window.api?.walkLoad === 'function'`, 90_000, 'window.api')
  }
  /** Stop the app's own processes (no others). Returns the PIDs it ended. */
  inst.halt = async () => {
    inst.cdp?.close()
    await inst.mcp?.close()
    inst.cdp = inst.mcp = null
    const res = await inst.proc.stop()
    inst.proc = null
    return [...res.terminated, ...res.killed]
  }
  inst.close = async () => {
    const pids = inst.proc ? await inst.halt() : []
    await renderer.close()
    await preview.close()
    return pids
  }
  await inst.boot()
  return inst
}

/** Cleanup of the run directory (kept with `--keep`). */
export const removeRunDir = (inst) => rmSync(inst.runDir, { recursive: true, force: true })
