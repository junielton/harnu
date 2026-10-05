import http from 'node:http'

export const getJson = (u) =>
  new Promise((res, rej) =>
    http
      .get(u, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            res(JSON.parse(d))
          } catch (e) {
            rej(e)
          }
        })
      })
      .on('error', rej)
  )

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = {}
  const listeners = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending[m.id]) {
      pending[m.id](m)
      delete pending[m.id]
    } else if (m.method) {
      for (const l of listeners) l(m)
    }
  })
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      pending[i] = res
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result?.result?.value
  }
  return { ws, send, evaluate, on: (f) => listeners.push(f), close: () => ws.close() }
}

export async function pageTarget(port) {
  const list = await getJson(`http://127.0.0.1:${port}/json`)
  return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
}

export async function nodeTarget(port) {
  const list = await getJson(`http://127.0.0.1:${port}/json`)
  return list[0]
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Summarize a .cpuprofile: top N by self time, plus total (inclusive) for named fns. */
export function summarize(profile, topN = 25, inclusiveNames = []) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const dt = profile.timeDeltas
  const counts = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]
    const d = dt[i] ?? 0
    self.set(id, (self.get(id) ?? 0) + d)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const total = dt.reduce((a, b) => a + b, 0)
  const byFn = new Map()
  const key = (n) => {
    const cf = n.callFrame
    const url = (cf.url || '').split('/').slice(-2).join('/')
    return `${cf.functionName || '(anon)'} ${url}:${cf.lineNumber + 1}`
  }
  for (const [id, t] of self) {
    const k = key(nodes.get(id))
    byFn.set(k, (byFn.get(k) ?? 0) + t)
  }
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
  // inclusive time: build parent map
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const incl = new Map(inclusiveNames.map((n) => [n, 0]))
  for (const [id, t] of self) {
    const seen = new Set()
    let cur = id
    while (cur != null) {
      const fn = nodes.get(cur).callFrame.functionName
      if (incl.has(fn) && !seen.has(fn)) {
        incl.set(fn, incl.get(fn) + t)
        seen.add(fn)
      }
      cur = parent.get(cur)
    }
  }
  const idle = [...byFn.entries()]
    .filter(
      ([k]) =>
        k.startsWith('(idle)') || k.startsWith('(program)') || k.startsWith('(garbage collector)')
    )
    .map(([k, v]) => [k.split(' ')[0], v])
  return { totalUs: total, top, inclusive: [...incl.entries()], idle }
}
