import { connect, pageTarget, nodeTarget, sleep } from './cdp.mjs'
import { locateLogpoints } from './locate.mjs'
import { PAGE_PORT, NODE_PORT, assertIsolated } from './procs.mjs'
const L = locateLogpoints()
const page = await connect((await pageTarget(PAGE_PORT)).webSocketDebuggerUrl)
const node = await connect((await nodeTarget(NODE_PORT)).webSocketDebuggerUrl)
await node.send('Runtime.enable')
await assertIsolated(node)
await node.send('Debugger.enable')
await node.evaluate('globalThis.__r = { full: [], uncached: [] }')
const bp = async (l, c) =>
  (
    await node.send('Debugger.setBreakpointByUrl', {
      lineNumber: l - 1,
      urlRegex: 'out/main/index\\.js$',
      condition: `(${c}), false`
    })
  ).result.breakpointId
const ids = [
  await bp(L.fullStart, 'globalThis.__r.tf = performance.now()'),
  await bp(L.fullEnd, 'globalThis.__r.full.push(performance.now() - globalThis.__r.tf)'),
  await bp(
    L.scanUncached,
    `globalThis.__r.uncached.push([Math.round(performance.now()), opts.slugsFilter ? opts.slugsFilter.length + ' slug(s)' : 'all'])`
  )
]
const t = await page.evaluate(
  `(async () => { const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('sessions'); const t0 = performance.now(); await s.rescan(); return performance.now() - t0 })()`
)
await sleep(15000)
console.log(
  'rescan() resolved ms',
  t.toFixed(0),
  await node.evaluate('JSON.stringify(globalThis.__r)')
)
for (const id of ids) await node.send('Debugger.removeBreakpoint', { breakpointId: id })
process.exit(0)
