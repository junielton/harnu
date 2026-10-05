// GPU-on CPU run: launch the instance WITHOUT --remote-debugging-port (it forces dev mode,
// which disables GPU acceleration) and pass only --inspect for the main process.
// Measures per-process CPU with animations on, injects `animation:none` through the main
// inspector (`webContents.insertCSS`), measures again, restores and measures a third time.
// Rows are labelled by `app.getAppMetrics()` type: Browser (main), Tab (renderer), GPU.
// usage: [NODE_PORT=9348] node gpu.mjs [secondsPerWindow=30]
import { connect, nodeTarget, sleep } from './cdp.mjs'
import { NODE_PORT, assertIsolated, mainEval, startCpuWindow } from './procs.mjs'

const secs = Number(process.argv[2] ?? 30)
const node = await connect((await nodeTarget(NODE_PORT)).webSocketDebuggerUrl)
await node.send('Runtime.enable')
await assertIsolated(node)
const ev = (e) => mainEval(node, e)
const wc = `require('electron').BrowserWindow.getAllWindows()[0].webContents`
console.log(
  'gpu_compositing',
  JSON.stringify(await ev(`require('electron').app.getGPUFeatureStatus().gpu_compositing`))
)

async function measure(label) {
  const win = await startCpuWindow(node)
  if (!win.procs.some((p) => p.type === 'GPU'))
    console.error('warning: no GPU process in getAppMetrics() — is GPU acceleration disabled?')
  await sleep(secs * 1000)
  const { wall, cpu } = win.end()
  const anims = await ev(
    `${wc}.executeJavaScript('document.getAnimations().map(a=>a.animationName).join(",")')`
  )
  console.log(
    label,
    JSON.stringify({
      wallS: +wall.toFixed(1),
      cpu: cpu.filter((p) => p.cpuPct > 0.3).map((p) => [p.type, p.cpuPct])
    }),
    anims
  )
}
await measure('all-on')
const key = await ev(`${wc}.insertCSS('*,*::before,*::after{animation:none!important}')`)
await measure('no-anim')
await ev(`${wc}.removeInsertedCSS(${JSON.stringify(key)})`)
await measure('all-on-again')
process.exit(0)
