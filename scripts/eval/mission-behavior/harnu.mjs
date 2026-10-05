/**
 * A throwaway, isolated Harnu instance for the mission behavior eval (T358 S5).
 *
 * This is what lets the eval go through Harnu's REAL MCP transport: the built
 * main process boots its loopback HTTP server, writes `harnu.mcp.json` (port +
 * bearer token) into its own `userData`, and every scripted `claude -p` session
 * is pointed at that file — the same `--mcp-config` document a session Harnu
 * spawns receives. Nothing is mocked between `claude` and the verb handlers.
 *
 * Isolation (docs/dev/live-verify-second-instance.md): a fresh `--user-data-dir`
 * under the run directory (its own single-instance lock, token and state) and a
 * free CDP port. On Linux it runs under `xvfb-run`, so no window opens on the
 * operator's desktop. The renderer is served from `out/renderer` by a tiny static
 * server because passing `--remote-debugging-port` puts the main process in dev
 * mode, which loads the renderer from a URL instead of from disk.
 *
 * CDP is used for exactly one thing: answering Claude Code's workspace-trust
 * dialog in a session Harnu spawns into the eval's own throwaway repo (the
 * harness plays the operator there, the same way it plays the operator for the
 * UI-only mission doors).
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createLedger, escalate, groupTarget } from './procs.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The parent environment minus every variable that marks a process as a child of
 * a running Claude Code session. Inherited, `CLAUDE_CODE_CHILD_SESSION` turns
 * transcript saving off in every session Harnu spawns — so no session would ever
 * "materialize" — and the messaging variables would register eval sessions as
 * peers of whoever launched the eval.
 */
export function cleanEnv(extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID') continue
    if (k === 'CLAUDE_EFFORT') continue
    env[k] = v
  }
  return { ...env, ...extra }
}

/** A free loopback TCP port. */
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
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

/** Serve `root` on 127.0.0.1 (never `localhost` — see the IPv6 shadow gotcha). */
async function serveStatic(root) {
  const port = await freePort()
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = path.join(root, urlPath === '/' ? 'index.html' : urlPath)
    if (!file.startsWith(root)) {
      res.writeHead(403).end()
      return
    }
    if (!existsSync(file)) file = path.join(root, 'index.html')
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

/** `electron-vite build` (no typecheck — the gates run that separately). */
export function buildApp(repoRoot, logFile) {
  const bin = path.join(repoRoot, 'node_modules', '.bin', 'electron-vite')
  execFileSync(bin, ['build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv()
  })
  return logFile
}

function hasCommand(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Evaluate a JS expression in the renderer over CDP (Node 22 global WebSocket). */
async function cdpEval(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('CDP websocket error'))
    })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluate timed out')), 15_000)
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data)
        if (d.id !== 1) return
        clearTimeout(timer)
        if (d.result?.exceptionDetails) {
          reject(new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 300)))
        } else resolve(d.result?.result?.value)
      }
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })
  } finally {
    ws.close()
  }
}

/**
 * In-page: find every live PTY showing Claude Code's workspace-trust dialog and
 * answer "Yes, I trust this folder" (arrow down, enter) — once per PTY. The
 * replay buffer renders spaces as cursor moves, hence the match on the text with
 * escapes and whitespace stripped.
 */
const TRUST_ANSWER_JS = `(async () => {
  window.__evalTrusted = window.__evalTrusted || new Set()
  const live = await window.api.ptyListLive()
  let answered = 0
  for (const p of live) {
    if (window.__evalTrusted.has(p.ptyId)) continue
    const r = await window.api.ptyReplay(p.ptyId)
    const text = String(r && (r.data ?? ''))
      .replace(/\\x1b\\[[0-9;?>]*[a-zA-Z]/g, '')
      .replace(/\\s+/g, '')
    if (!text.includes('Itrustthisfolder')) continue
    window.__evalTrusted.add(p.ptyId)
    window.api.ptyWrite(p.ptyId, '\\x1b[B')
    await new Promise((res) => setTimeout(res, 400))
    window.api.ptyWrite(p.ptyId, '\\r')
    answered++
  }
  return answered
})()`

/** In-page: every live PTY's session key and the tail of its screen, escapes stripped. */
const DUMP_PTYS_JS = `(async () => {
  const out = []
  for (const p of await window.api.ptyListLive()) {
    const r = await window.api.ptyReplay(p.ptyId)
    const text = String(r && (r.data ?? '')).replace(/\\x1b\\[[0-9;?>]*[a-zA-Z]/g, '').replace(/\\x1b\\][^\\x07]*\\x07/g, '')
    out.push('== ' + p.sessionKey + ' (' + p.kind + ')\\n' + text.slice(-1500))
  }
  return out.join('\\n\\n') || '(no live PTY)'
})()`

/** Every instance this process launched and has not finished stopping. */
const launched = new Set()

/**
 * Last-resort kill for an interrupted run (SIGINT/SIGTERM): escalate on every
 * instance this process launched, even one still booting. No graceful quit.
 */
export async function killAllLaunched() {
  const targets = []
  for (const inst of launched) {
    inst.ledger.snapshot()
    targets.push(groupTarget(inst.pgid), ...inst.ledger.alive().map((e) => inst.ledger.target(e)))
  }
  launched.clear()
  return escalate(targets)
}

/** In-page: destroy every live PTY (all of them belong to the eval in this instance). */
const DESTROY_PTYS_JS = `(async () => {
  const live = await window.api.ptyListLive()
  for (const p of live) window.api.ptyDestroy(p.ptyId)
  return live.length
})()`

/**
 * Start an isolated Harnu instance and connect an MCP client to it.
 *
 * @param {{ repoRoot: string, runDir: string, log: (s: string) => void }} opts
 */
export async function startHarnu({ repoRoot, runDir, log }) {
  const userData = path.join(runDir, 'userData')
  const renderer = await serveStatic(path.join(repoRoot, 'out', 'renderer'))
  const cdpPort = await freePort()
  const electronBin = path.join(repoRoot, 'node_modules', '.bin', 'electron')
  const appArgs = [
    path.join(repoRoot, 'out', 'main', 'index.js'),
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${cdpPort}`,
    '--no-sandbox'
  ]
  const useXvfb = process.platform === 'linux' && hasCommand('xvfb-run')
  const [cmd, args] = useXvfb
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', electronBin, ...appArgs]]
    : [electronBin, appArgs]
  // No D-Bus session: the instance watches the operator's real ~/.claude and
  // would otherwise raise desktop notifications about their real sessions.
  const env = cleanEnv({ ELECTRON_RENDERER_URL: renderer.url })
  delete env.DBUS_SESSION_BUS_ADDRESS
  const out = createWriteStream(path.join(runDir, 'harnu.log'))
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  log(`harnu: pid ${child.pid}${useXvfb ? ' (xvfb)' : ''}, userData ${userData}`)
  // Record the instance's process tree while it is intact: the sessions it
  // spawns get their own session id and are reparented to init if it dies, so
  // this ledger is the only reliable record of what the eval started.
  const ledger = createLedger()
  ledger.trackRoot(child.pid)
  const registration = { pgid: child.pid, ledger }
  launched.add(registration)
  const snapshotTimer = setInterval(() => ledger.snapshot(), 1_000)
  snapshotTimer.unref()
  // A boot that never comes up must not leave the instance running.
  const abortBoot = async (err) => {
    clearInterval(snapshotTimer)
    ledger.snapshot()
    await escalate([groupTarget(child.pid), ...ledger.alive().map((e) => ledger.target(e))])
    launched.delete(registration)
    await renderer.close()
    throw err
  }
  try {
    return await connectToInstance()
  } catch (err) {
    return abortBoot(err)
  }

  async function connectToInstance() {
    const configPath = path.join(userData, 'harnu.mcp.json')
    const started = Date.now()
    while (!existsSync(configPath)) {
      if (child.exitCode !== null)
        throw new Error(`Harnu exited early (code ${child.exitCode}) — see harnu.log`)
      if (Date.now() - started > 90_000) throw new Error('Harnu MCP server did not come up in 90s')
      await sleep(500)
    }
    let wsUrl = null
    while (!wsUrl) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()
        wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null
      } catch {
        /* not up yet */
      }
      if (!wsUrl) {
        if (Date.now() - started > 90_000)
          throw new Error('Harnu CDP target did not come up in 90s')
        await sleep(500)
      }
    }
    // The renderer must have mounted window.api before the trust watcher can use it.
    while (
      (await cdpEval(wsUrl, 'typeof window.api?.ptyListLive').catch(() => '')) !== 'function'
    ) {
      if (Date.now() - started > 90_000)
        throw new Error('Harnu renderer did not expose window.api in 90s')
      await sleep(500)
    }

    const server = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.harnu
    const client = new Client({ name: 'mission-behavior-eval', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers }
      })
    )
    log(
      `harnu: MCP up at ${server.url} (bearer from harnu.mcp.json), ready in ${Date.now() - started}ms`
    )

    let trustTimer = null
    return {
      configPath,
      userData,
      /** Call a verb through the real transport; returns the parsed JSON payload. */
      async call(name, args, timeoutMs = 120_000) {
        const res = await client.callTool({ name, arguments: args }, undefined, {
          timeout: timeoutMs
        })
        const text = res.content?.[0]?.text ?? ''
        let payload
        try {
          payload = JSON.parse(text)
        } catch {
          payload = { raw: text }
        }
        return { isError: res.isError === true, payload }
      },
      /** Start answering workspace-trust dialogs in spawned sessions (1s tick). */
      startTrustWatcher() {
        if (trustTimer) return
        let lastError = ''
        trustTimer = setInterval(() => {
          cdpEval(wsUrl, TRUST_ANSWER_JS)
            .then((n) => {
              if (n) log(`harnu: answered ${n} workspace-trust dialog(s) as the operator`)
            })
            .catch((e) => {
              if (e.message !== lastError) log(`harnu: trust watcher: ${e.message}`)
              lastError = e.message
            })
        }, 1_000)
      },
      /** The tail of every live PTY's screen, for a failed spawn's evidence. */
      async dumpPtys() {
        return cdpEval(wsUrl, DUMP_PTYS_JS).catch((e) => `could not read PTYs: ${e.message}`)
      },
      stopTrustWatcher() {
        if (trustTimer) clearInterval(trustTimer)
        trustTimer = null
      },
      /**
       * Kill every session the instance spawned into `dir` (a scenario's sandbox):
       * destroy their PTYs through Harnu, then SIGTERM → SIGKILL any recorded
       * process still running there. The instance itself keeps running.
       */
      async killChildren(dir) {
        ledger.snapshot()
        await cdpEval(wsUrl, DESTROY_PTYS_JS).catch(() => 0)
        const res = await escalate(ledger.aliveUnder(dir).map((e) => ledger.target(e)))
        if (res.terminated.length || res.killed.length) {
          log(
            `    killed spawned session processes: ${res.terminated.length} on SIGTERM, ` +
              `${res.killed.length} on SIGKILL`
          )
        }
      },
      async stop() {
        this.stopTrustWatcher()
        ledger.snapshot()
        await client.close().catch(() => {})
        // Graceful first: closing the window quits the app, and `before-quit`
        // kills every PTY it spawned.
        await cdpEval(wsUrl, 'window.close()').catch(() => {})
        for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250)
        clearInterval(snapshotTimer)
        // Then escalate on exactly what the eval started: the process group it
        // launched, and every recorded process (spawned sessions have their own
        // group, so the group signal alone would miss them).
        const res = await escalate([
          groupTarget(child.pid),
          ...ledger.alive().map((e) => ledger.target(e))
        ])
        if (res.killed.length)
          log(`harnu: SIGKILLed after the grace period: ${res.killed.join(', ')}`)
        launched.delete(registration)
        await renderer.close()
      }
    }
  }
}
