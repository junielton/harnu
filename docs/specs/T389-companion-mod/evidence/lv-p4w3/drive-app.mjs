/* eslint-disable @typescript-eslint/explicit-function-return-type -- evidence driver script, not product code */
// P4W3 live-verify driver: a SECOND, isolated Harnu (own userData, throwaway HOME and Claude config
// dir, own CDP port) driven over CDP, with one real interactive `claude` in tmux against it.
//
// SAFETY: every path below lives under one throwaway root. The script prints the resolved settings
// path first and aborts when it is under the real home's `.claude`, before anything is written.
//
// Usage: node drive-app.mjs <repo> <cli-dir holding claude> <outdir for logs and screenshots>
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const [repo, cliDir, outDir] = process.argv.slice(2)
if (!repo || !cliDir || !outDir) throw new Error('usage: drive-app.mjs <repo> <cli-dir> <outdir>')
mkdirSync(outDir, { recursive: true })
const LOG = join(outDir, 'lv-app.log')
const log = (s) => {
  console.log(s)
  appendFileSync(LOG, s + '\n')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'harnu-lvapp-'))
const home = join(root, 'home')
const configDir = join(home, '.claude')
const settingsPath = join(configDir, 'settings.json')
const userData = join(root, 'userData')
const cwd = join(root, 'project')
const realClaude = join(homedir(), '.claude')
log(`resolved settings path: ${settingsPath}`)
if (
  resolve(settingsPath).startsWith(realClaude) ||
  resolve(root).startsWith(realClaude) ||
  resolve(configDir) === realClaude
) {
  throw new Error('ABORT: the settings path is under the real home')
}
for (const d of [configDir, userData, cwd]) mkdirSync(d, { recursive: true })
const BEFORE =
  JSON.stringify(
    { permissions: { allow: ['Read'] }, cleanupPeriodDays: 30, tui: 'fullscreen' },
    null,
    2
  ) + '\n'
writeFileSync(settingsPath, BEFORE)
writeFileSync(
  join(configDir, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    numStartups: 5,
    projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [] } }
  })
)
log(
  `claude --version (PATH first entry ${cliDir}): ${execFileSync(join(cliDir, 'claude'), ['--version']).toString().trim()}`
)

// ---- static renderer ----------------------------------------------------------------------
const rendererDir = join(repo, 'out', 'renderer')
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
}
const server = createServer((req, res) => {
  let p = join(rendererDir, decodeURIComponent((req.url ?? '/').split('?')[0]))
  if (!p.startsWith(rendererDir) || !existsSync(p) || statSync(p).isDirectory())
    p = join(rendererDir, 'index.html')
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
  createReadStream(p).pipe(res)
})
await new Promise((r) => server.listen(5199, '127.0.0.1', r))

// ---- electron -----------------------------------------------------------------------------
const CDP = 9334
const pathEnv = `${cliDir}:${process.env.PATH}`
const electronArgs = [
  `PATH=${pathEnv}`,
  `HOME=${home}`,
  `CLAUDE_CONFIG_DIR=${configDir}`,
  'TERM=xterm-256color',
  `ELECTRON_RENDERER_URL=http://127.0.0.1:5199`,
  'DISABLE_AUTOUPDATER=1',
  join(repo, 'node_modules/.bin/electron'),
  '.',
  `--user-data-dir=${userData}`,
  `--remote-debugging-port=${CDP}`,
  '--no-sandbox'
]
// `env -i` strips DISPLAY, which xvfb-run sets for its child: hand it through explicitly.
const electron = spawn(
  'xvfb-run',
  [
    '-a',
    '-s',
    '-screen 0 1440x900x24',
    'sh',
    '-c',
    `exec env -i DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" ${electronArgs.join(' ')}`
  ],
  { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
)
let appLog = ''
electron.stdout.on('data', (d) => (appLog += d))
electron.stderr.on('data', (d) => (appLog += d))

const getJson = async (u) => (await fetch(u)).json()
let ws
let msgId = 0
const pending = new Map()
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await getJson(`http://127.0.0.1:${CDP}/json`)).find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl
      )
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        break
      }
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  if (!ws) throw new Error('no CDP page')
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
}
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64'))
  log(`screenshot: ${name}`)
}
const tmuxSession = 'harnu-lvapp'
const tmux = (...a) => execFileSync('tmux', a).toString()
const readSettings = () => readFileSync(settingsPath, 'utf8')

const results = {}
try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  for (let i = 0; i < 60; i++) {
    if ((await ev('typeof window.api?.companionExternalGet')) === 'function') break
    await sleep(500)
  }
  await sleep(2500)
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })

  // The app's own legacy hook installer rewrites `hooks` in settings.json at boot (existing
  // behaviour, not this wave): the baseline for "untouched" and "exact undo" is the file as it is
  // once the app has settled, and the difference is logged.
  await sleep(3000)
  const BASE = readSettings()
  log(
    `settings.json at boot differs from the seeded file (Harnu's own hook installer): ${BASE !== BEFORE}`
  )
  log(`baseline: ${JSON.stringify(JSON.parse(BASE)).slice(0, 300)}`)

  // 1. the state before anything: off, nothing written
  const st0 = await ev('window.api.companionExternalGet()')
  log(`externalGet (before): ${JSON.stringify(st0)}`)
  results.offByDefault = st0.on === false && readSettings() === BASE
  log(`default off, settings untouched: ${results.offByDefault}`)

  // 2. Settings → Mods, the Advanced block, light and dark
  await ev(
    `(() => { const app = document.querySelector('#app').__vue_app__; app.config.globalProperties.$pinia._s.get('ui').openSettings('mods'); return true })()`
  )
  await sleep(1500)
  await ev(`document.querySelector('[data-testid="mods-external-advanced"]')?.click()`)
  await sleep(500)
  const modsDom = await ev(`document.querySelector('[data-testid="mods-external"]')?.innerText`)
  log(`Mods → Advanced block text: ${JSON.stringify(modsDom)}`)
  await shot('P4W3-switch-off-dark.png')

  // 3. turn on: the confirm dialog first, nothing written until "Turn on"
  await ev(`document.querySelector('[data-testid="mods-external-toggle"]')?.click()`)
  await sleep(700)
  const dialog = await ev(
    `document.querySelector('[data-testid="mods-external-confirm"]')?.innerText`
  )
  const entryShown = await ev(
    `document.querySelector('[data-testid="mods-external-entry"]')?.innerText`
  )
  log(`confirm dialog text: ${JSON.stringify(dialog)}`)
  log(`confirm dialog entry: ${entryShown}`)
  results.confirmShown = Boolean(dialog)
  results.writtenBeforeAccept = readSettings() !== BASE
  log(`settings changed before "Turn on": ${results.writtenBeforeAccept}`)
  await shot('P4W3-confirm.png')
  await ev(`document.documentElement.setAttribute('data-theme', 'light')`)
  await sleep(500)
  await shot('P4W3-confirm-light.png')
  await ev(`document.documentElement.setAttribute('data-theme', 'dark')`)

  // Cancel leaves everything untouched
  await ev(
    `[...document.querySelectorAll('[data-testid="mods-external-confirm"] button')].find((b) => b.innerText.trim() === 'Cancel')?.click()`
  )
  await sleep(400)
  results.cancelUntouched =
    readSettings() === BASE &&
    !(await ev(`!!document.querySelector('[data-testid="mods-external-confirm"]')`))
  log(`Cancel leaves the file untouched and closes the dialog: ${results.cancelUntouched}`)

  // 4. turn on for real
  await ev(`document.querySelector('[data-testid="mods-external-toggle"]')?.click()`)
  await sleep(500)
  await ev(`document.querySelector('[data-testid="mods-external-accept"]')?.click()`)
  for (let i = 0; i < 40; i++) {
    if ((await ev('window.api.companionExternalGet()')).on) break
    await sleep(500)
  }
  const st1 = await ev('window.api.companionExternalGet()')
  log(`externalGet (on): ${JSON.stringify(st1)}`)
  const onText = readSettings()
  log(`settings.json after on: ${JSON.stringify(JSON.parse(onText))}`)
  const onParsed = JSON.parse(onText)
  results.onWroteOneEntry =
    st1.on === true &&
    onParsed.env?.CLAUDE_CODE_PLUGIN_DIRS === st1.entry &&
    JSON.stringify(Object.fromEntries(Object.entries(onParsed).filter(([k]) => k !== 'env'))) ===
      JSON.stringify(JSON.parse(BASE))
  log(`one entry written, every other key kept: ${results.onWroteOneEntry}`)
  await sleep(600)
  await shot('P4W3-switch-on-dark.png')
  await ev(`document.documentElement.setAttribute('data-theme', 'light')`)
  await sleep(500)
  await shot('P4W3-switch-on-light.png')
  await ev(`document.documentElement.setAttribute('data-theme', 'dark')`)

  // 5. a plain-terminal session (tmux), settings env only: external hello, corroboration, state
  const claudeCmd = [
    'env -i',
    `PATH='${pathEnv}'`,
    `HOME='${home}'`,
    `CLAUDE_CONFIG_DIR='${configDir}'`,
    'TERM=xterm-256color',
    'DISABLE_AUTOUPDATER=1',
    'claude',
    `--debug-file '${join(root, 'session.debug.log')}'`
  ].join(' ')
  try {
    tmux('kill-session', '-t', tmuxSession)
  } catch {
    /* none */
  }
  tmux('new-session', '-d', '-s', tmuxSession, '-x', '200', '-y', '50', '-c', cwd, claudeCmd)
  let binding = null
  for (let i = 0; i < 60 && !binding; i++) {
    await sleep(500)
    const d = await ev('window.api.companionDiagnostics()')
    binding = d.bindings.find((b) => b.profile === 'external') ?? null
  }
  log(`diagnostics binding: ${JSON.stringify(binding)}`)
  const debug = existsSync(join(root, 'session.debug.log'))
    ? readFileSync(join(root, 'session.debug.log'), 'utf8')
    : ''
  results.externalHello = Boolean(binding) && binding.sessionKey === null
  results.loadedOnce =
    (debug.match(/hooks module harnu-companion@inline loaded/g) ?? []).length === 1
  results.noGateApproval = Boolean(binding) && !binding.enabled.includes('gate.approval')
  log(
    `external hello via the settings env alone: ${results.externalHello}; loaded lines: ${(debug.match(/hooks module harnu-companion@inline loaded/g) ?? []).length}`
  )
  const sid = binding?.sid
  // Corroboration: the PID registry entry of this process (sessionId + cwd) or the transcript.
  await sleep(4000)
  const reg = (() => {
    try {
      const dir = join(configDir, 'sessions')
      return existsSync(dir) ? execFileSync('ls', [dir]).toString().trim() : '(no sessions dir)'
    } catch {
      return '(unreadable)'
    }
  })()
  log(`~/.claude/sessions in the throwaway config dir: ${reg}`)
  const status = await ev('window.api.companionStatus()')
  log(
    `companionStatus.sessions[sid]: ${JSON.stringify(status.sessions[sid] ? status.sessions[sid].state : null)}`
  )
  results.stateWhileUncorroborated = JSON.stringify(status.sessions[sid]?.state ?? null)
  results.corroboratedView = (await ev('window.api.companionDiagnostics()')).bindings.find(
    (b) => b.profile === 'external'
  )

  // 6. off: exact undo, the live binding is revoked, a new session says nothing
  await ev(`document.querySelector('[data-testid="mods-external-toggle"]')?.click()`)
  for (let i = 0; i < 40; i++) {
    if (!(await ev('window.api.companionExternalGet()')).on) break
    await sleep(500)
  }
  const st2 = await ev('window.api.companionExternalGet()')
  const offText = readSettings()
  log(`externalGet (off): ${JSON.stringify(st2)}`)
  log(`settings.json after off: ${JSON.stringify(JSON.parse(offText))}`)
  results.undoJsonEqual = JSON.stringify(JSON.parse(offText)) === JSON.stringify(JSON.parse(BASE))
  results.undoByteEqual = offText === BASE
  log(
    `undo — JSON-normalised equal: ${results.undoJsonEqual}; byte equal: ${results.undoByteEqual}`
  )
  await sleep(1500)
  const d2 = await ev('window.api.companionDiagnostics()')
  results.revoked =
    d2.bindings.filter(
      (b) => b.profile === 'external' && b.state === 'bound' && b.enabled.length > 0
    ).length === 0
  log(
    `live external bindings still enabled after off: ${d2.bindings.filter((b) => b.profile === 'external' && b.enabled.length > 0).length}`
  )
  await shot('P4W3-switch-off-again-dark.png')
  try {
    tmux('kill-session', '-t', tmuxSession)
  } catch {
    /* gone */
  }
  log(`RESULTS ${JSON.stringify(results)}`)
} catch (e) {
  log(`FAILED ${e?.stack ?? e}`)
  log(`app log tail:\n${appLog.slice(-2500)}`)
} finally {
  try {
    tmux('kill-session', '-t', tmuxSession)
  } catch {
    /* gone */
  }
  try {
    ws?.close()
  } catch {
    /* closed */
  }
  server.close()
  // Only the processes this script started: the xvfb-run tree it spawned, by pid.
  try {
    process.kill(-electron.pid)
  } catch {
    /* not a group leader */
  }
  electron.kill('SIGTERM')
  await sleep(1500)
  writeFileSync(join(outDir, 'app-stdout.log'), appLog.slice(-20000))
  rmSync(root, { recursive: true, force: true })
}
