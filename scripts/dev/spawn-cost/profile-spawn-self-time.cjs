// Reads a V8 .cpuprofile and prints the biggest self-time frames, plus every `spawn` frame (BUG-266).
const fs = require('fs')
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const nodes = new Map(p.nodes.map((n) => [n.id, n]))
const self = new Map()
const dt = p.timeDeltas
for (let i = 0; i < p.samples.length; i++)
  self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + (dt[i] ?? 0))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const rows = []
for (const [id, us] of self) {
  const n = nodes.get(id)
  rows.push({
    ms: us / 1000,
    fn: n.callFrame.functionName || '(anon)',
    url: (n.callFrame.url || '').split('/').slice(-2).join('/') + ':' + n.callFrame.lineNumber,
    id
  })
}
rows.sort((a, b) => b.ms - a.ms)
console.log('total ms', (p.endTime - p.startTime) / 1000)
for (const r of rows.slice(0, 15)) {
  const chain = []
  let c = r.id
  for (let k = 0; k < 6 && c; k++) {
    const n = nodes.get(c)
    chain.push(n.callFrame.functionName || '(anon)')
    c = parent.get(c)
  }
  console.log(r.ms.toFixed(0).padStart(6), r.fn, r.url, '<-', chain.slice(1).join(' < '))
}
// samples whose self frame is spawn
const sp = rows.filter((r) => /^(spawn|ChildProcess\.spawn|execFile)$/.test(r.fn))
console.log('spawn rows', sp.map((r) => r.ms.toFixed(0)).join(','))
