// Baseline measurement against an ISOLATED Harnu instance.
// usage: node measure.mjs <mode> <seconds>   mode = cpu | instr | profile
// Needs the page CDP port and the main-process inspector port (see README); the
// per-process CPU rows are labelled by `app.getAppMetrics()` type.
import { writeFileSync } from 'node:fs'
import { connect, pageTarget, nodeTarget, sleep, summarize } from './cdp.mjs'
import { locateLogpoints } from './locate.mjs'
import { PAGE_PORT, NODE_PORT, assertIsolated, startCpuWindow } from './procs.mjs'

const [mode, secsArg] = process.argv.slice(2)
const secs = Number(secsArg ?? 60)
const OUT = process.env.OUTDIR ?? '.'

const page = await connect((await pageTarget(PAGE_PORT)).webSocketDebuggerUrl)
await page.send('Runtime.enable')

// Renderer-side event counters (fresh subscriptions — window.api is frozen, so we subscribe, not patch).
await page.evaluate(`(() => {
  if (window.__ev) { for (const k in window.__ev) window.__ev[k] = typeof window.__ev[k] === 'number' ? 0 : window.__ev[k]; window.__ev.sessions = new Set(); return }
  const ev = window.__ev = { upd: 0, updBytes: 0, add: 0, rem: 0, sub: 0, subBytes: 0, idx: 0, proj: 0, sessions: new Set() }
  window.api.onSessionUpdated((p) => { ev.upd++; ev.updBytes += JSON.stringify(p).length; ev.sessions.add(p.sessionId) })
  window.api.onSessionAdded(() => ev.add++)
  window.api.onSessionRemoved(() => ev.rem++)
  window.api.onSubagentUpdated((p) => { ev.sub++; ev.subBytes += JSON.stringify(p).length })
  window.api.onIndexUpdated(() => ev.idx++)
  window.api.onProjectAdded(() => ev.proj++)
})()`)

const node = await connect((await nodeTarget(NODE_PORT)).webSocketDebuggerUrl)
await node.send('Runtime.enable')
await assertIsolated(node)
const BP = []
async function logpoint(line1, cond) {
  const r = await node.send('Debugger.setBreakpointByUrl', {
    lineNumber: line1 - 1,
    urlRegex: 'out/main/index\\.js$',
    condition: `(${cond}), false`
  })
  if (!r.result?.breakpointId) console.error('bp fail', line1, JSON.stringify(r))
  BP.push(r.result?.breakpointId)
}
const M = `(globalThis.__m ||= {passes:[],slugN:[],full:[],gitRev:0,gitStatus:0,miss:0,appendRead:0,subHdr:0,notify:0,notifyAppend:0,upd:0,updBytes:0,subUpd:0})`

if (mode === 'instr') {
  const L = locateLogpoints()
  await node.send('Debugger.enable')
  await node.evaluate(`globalThis.__m = undefined`)
  await logpoint(L.gitRev, `${M}.gitRev++`)
  await logpoint(L.gitStatus, `${M}.gitStatus++`)
  await logpoint(L.jsonlMiss, `${M}.miss++`)
  await logpoint(L.jsonlAppend, `${M}.appendRead++`)
  await logpoint(L.subHdr, `${M}.subHdr++`)
  await logpoint(L.notify, `${M}.notify++, ${M}.notifyAppend += cls === 'append' ? 1 : 0`)
  await logpoint(L.slugStart, `${M}.t0 = performance.now(), ${M}.slugN.push(slugs.length)`)
  await logpoint(L.slugEnd, `${M}.passes.push(performance.now() - ${M}.t0)`)
  await logpoint(L.fullStart, `${M}.tf = performance.now()`)
  await logpoint(L.fullEnd, `${M}.full.push(performance.now() - ${M}.tf)`)
  // One flush line sends both coalesced channels; bytes are the payload actually sent.
  await logpoint(
    L.sessUpd,
    `ev.channel === 'claude:session:updated' ? (${M}.upd++, ${M}.updBytes += JSON.stringify(ev.payload).length) : ev.channel === 'claude:subagent:updated' ? ${M}.subUpd++ : 0`
  )
}

const win = await startCpuWindow(node)
if (mode === 'profile') {
  await node.send('Profiler.enable')
  await node.send('Profiler.setSamplingInterval', { interval: 500 })
  await page.send('Profiler.enable')
  await page.send('Profiler.setSamplingInterval', { interval: 500 })
  await node.send('Profiler.start')
  await page.send('Profiler.start')
}
await sleep(secs * 1000)
const { wall, cpu } = win.end()
const ev = await page.evaluate(
  `(() => { const e = window.__ev; return { ...e, sessions: e.sessions.size } })()`
)
// Derived per-event figures (spec §1.2): rate and size of the IPC the renderer receives.
const rate = (n, bytes) => ({
  perS: +(n / wall).toFixed(2),
  bytesPerEvent: n ? Math.round(bytes / n) : null
})
const res = {
  mode,
  wallS: +wall.toFixed(1),
  cpu,
  renderer: {
    ...ev,
    sessionUpdated: rate(ev.upd, ev.updBytes),
    subagentUpdated: rate(ev.sub, ev.subBytes)
  }
}
if (mode === 'instr') {
  const m = await node.evaluate(`JSON.stringify(globalThis.__m ?? null)`)
  const mm = JSON.parse(m)
  if (mm) {
    const p = [...mm.passes].sort((a, b) => a - b)
    const q = (x) =>
      p.length ? +p[Math.min(p.length - 1, Math.floor(x * p.length))].toFixed(1) : null
    res.main = {
      slugPasses: p.length,
      passesPerS: +(p.length / wall).toFixed(2),
      passMs: {
        p50: q(0.5),
        p90: q(0.9),
        max: q(0.999),
        sum: +p.reduce((a, b) => a + b, 0).toFixed(0)
      },
      slugsPerPass: +(mm.slugN.reduce((a, b) => a + b, 0) / Math.max(1, mm.slugN.length)).toFixed(
        2
      ),
      fullRescansMs: mm.full.map((x) => +x.toFixed(0)),
      notifySlug: mm.notify,
      notifySlugAppend: mm.notifyAppend,
      jsonlHeaderMisses: mm.miss,
      jsonlHeaderAppendReads: mm.appendRead,
      subagentHeaderReads: mm.subHdr,
      gitRevParseSpawns: mm.gitRev,
      gitStatusSpawns: mm.gitStatus,
      sessionUpdatedSends: mm.upd,
      sessionUpdatedPayloadBytes: mm.updBytes,
      subagentUpdatedSends: mm.subUpd
    }
  }
  for (const id of BP) await node.send('Debugger.removeBreakpoint', { breakpointId: id })
  await node.send('Debugger.disable')
}
if (mode === 'profile') {
  const pm = await node.send('Profiler.stop')
  const pr = await page.send('Profiler.stop')
  writeFileSync(`${OUT}/main.cpuprofile`, JSON.stringify(pm.result.profile))
  writeFileSync(`${OUT}/renderer.cpuprofile`, JSON.stringify(pr.result.profile))
  res.mainProfile = summarize(pm.result.profile, 25, [
    'drainRefresh',
    'scanFoldersUncached',
    'scrapeJsonlHeader',
    'scrapeSubagentHeader',
    'attachSubagents',
    'readProjectFromJsonls',
    'readTailEntries',
    'tailFile',
    'probeGitMetaBatch',
    'buildFolderEntries',
    'mergeSlugSessions',
    'deriveFolders'
  ])
  res.rendererProfile = summarize(pr.result.profile, 25, [
    'reloadModelOnce',
    'reloadModel',
    'commitFolders',
    'mergeFolders',
    'flushJobs',
    'flushPreFlushCbs',
    'triggerEffects',
    'refreshComputed'
  ])
}
console.log(JSON.stringify(res, null, 1))
page.close()
node.close()
process.exit(0)
