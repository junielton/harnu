/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars -- a standalone probe script run by Electron/Node directly */
// AC-1 probe (BUG-266). Run inside the real Electron main process:
//   BALLAST_MB=300 CHURN=0 node_modules/electron/dist/electron --no-sandbox --disable-gpu --ozone-platform=headless scripts/dev/spawn-cost/main-cost.cjs
// Prints the main-thread cost of one execFile() (a fork) against the cost of handing the same call to a utilityProcess.
// Runs inside Electron's REAL main process (not ELECTRON_RUN_AS_NODE).
const { app, utilityProcess } = require('electron')
const cp = require('node:child_process')
const { Worker } = require('node:worker_threads')
const mb = Number(process.env.BALLAST_MB ?? 0)
globalThis.__ballast = []
for (let i = 0; i < mb; i++) globalThis.__ballast.push(Buffer.alloc(1 << 20, (i & 255) + 1))
globalThis.__heap = []
for (let i = 0; i < mb * 1500; i++) globalThis.__heap.push({ i, s: 'row-' + i, a: [i, i + 1] })
const churn = process.env.CHURN === '1'
function stats(t) {
  t.sort((a, b) => a - b)
  const n = t.length
  return `median=${t[n >> 1].toFixed(1)} p90=${t[Math.floor(n * 0.9)].toFixed(1)} max=${t[n - 1].toFixed(1)}`
}
app.whenReady().then(async () => {
  const rss = Math.round(process.memoryUsage().rss / 1048576)
  if (churn) {
    // a second thread that allocates + frees (GC/page-fault pressure like the renderer helpers + workers do)
    new Worker(
      `const a=[];setInterval(()=>{},1000);while(true){a.push(Buffer.alloc(1<<20,1));if(a.length>64)a.length=0}`,
      { eval: true }
    )
    await new Promise((r) => setTimeout(r, 500))
  }
  const direct = []
  for (let i = 0; i < 30; i++) {
    const s = process.hrtime.bigint()
    const c = cp.execFile('git', ['--version'], () => {})
    direct.push(Number(process.hrtime.bigint() - s) / 1e6)
    await new Promise((r) => setTimeout(r, 30))
  }
  // helper: a utilityProcess that forks on our behalf
  const helper = utilityProcess.fork(require('path').join(__dirname, 'helper.cjs'), [], {
    stdio: 'ignore'
  })
  await new Promise((r) => helper.once('message', r))
  const viaHelper = []
  const roundtrip = []
  for (let i = 0; i < 30; i++) {
    const s = process.hrtime.bigint()
    const done = new Promise((r) => helper.once('message', r))
    helper.postMessage({ file: 'git', args: ['--version'] })
    viaHelper.push(Number(process.hrtime.bigint() - s) / 1e6)
    const t0 = Date.now()
    const m = await done
    roundtrip.push(Date.now() - t0)
  }
  console.log(
    `RESULT rss=${rss}MB churn=${churn} | main-thread cost direct execFile: ${stats(direct)} ms | via utilityProcess postMessage: ${stats(viaHelper)} ms | round trip ${stats(roundtrip)} ms`
  )
  helper.kill()
  app.quit()
})
