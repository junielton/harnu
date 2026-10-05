// Synthetic fleet fixture + steady append load (fake HOME), so CPU numbers are
// reproducible. usage:
//   node fixture.mjs build <HOME> <WORKDIR>
//   node fixture.mjs load  <HOME> <WORKDIR> <seconds>
import { mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const [cmd, HOME, WD, secs] = process.argv.slice(2)
const P = `${HOME}/.claude/projects`
const slugOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-')
const pad = 'x'.repeat(900)
const sid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const user = (s, cwd, text) =>
  JSON.stringify({
    type: 'user',
    sessionId: s,
    cwd,
    entrypoint: 'cli',
    gitBranch: 'main',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text }
  })
const asst = (s, cwd, n) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: s,
    cwd,
    entrypoint: 'cli',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      model: 'm',
      usage: { input_tokens: 1000, output_tokens: 10 },
      content: [{ type: 'text', text: `reply ${n} ${pad}` }]
    }
  })
const sub = (a, n) =>
  JSON.stringify({
    type: n === 0 ? 'user' : 'assistant',
    agentId: a,
    attributionAgent: 'general-purpose',
    isSidechain: true,
    uuid: randomUUID(),
    message:
      n === 0
        ? { role: 'user', content: 'subagent task ' + a }
        : { role: 'assistant', model: 'm', content: [{ type: 'text', text: pad }] }
  })

const HEAVY = `${WD}/heavy`
const old = new Date(Date.now() - 3 * 86400_000)
if (cmd === 'build') {
  // heavy slug: 300 session transcripts (~180 KB each), 40 parents x 10 subagents (~45 KB each)
  const hd = `${P}/${slugOf(HEAVY)}`
  mkdirSync(hd, { recursive: true })
  mkdirSync(HEAVY, { recursive: true })
  for (let i = 0; i < 300; i++) {
    const s = sid(i)
    const lines = [user(s, HEAVY, `heavy session ${i}`)]
    for (let n = 0; n < 200; n++) lines.push(asst(s, HEAVY, n))
    writeFileSync(`${hd}/${s}.jsonl`, lines.join('\n') + '\n')
    utimesSync(`${hd}/${s}.jsonl`, old, i === 0 ? new Date() : old)
  }
  for (let p = 0; p < 40; p++) {
    const sd = `${hd}/${sid(p)}/subagents`
    mkdirSync(sd, { recursive: true })
    for (let a = 0; a < 10; a++) {
      const id = `a${p}x${a}`
      const lines = []
      for (let n = 0; n < 50; n++) lines.push(sub(id, n))
      writeFileSync(`${sd}/agent-${id}.jsonl`, lines.join('\n') + '\n')
      utimesSync(`${sd}/agent-${id}.jsonl`, old, old)
    }
  }
  // 30 light slugs x 10 sessions
  for (let k = 0; k < 30; k++) {
    const cwd = `${WD}/light${k}`
    mkdirSync(cwd, { recursive: true })
    const d = `${P}/${slugOf(cwd)}`
    mkdirSync(d, { recursive: true })
    for (let i = 0; i < 10; i++) {
      const s = sid(10000 + k * 100 + i)
      const lines = [user(s, cwd, `light ${k}/${i}`)]
      for (let n = 0; n < 40; n++) lines.push(asst(s, cwd, n))
      writeFileSync(`${d}/${s}.jsonl`, lines.join('\n') + '\n')
    }
  }
  console.log('built')
} else if (cmd === 'load') {
  // Steady load: 2 sessions + 2 subagents in the heavy slug, each appending every 500 ms (8 appends/s).
  const hd = `${P}/${slugOf(HEAVY)}`
  const targets = [
    (n) => appendFileSync(`${hd}/${sid(0)}.jsonl`, asst(sid(0), HEAVY, n) + '\n'),
    (n) => appendFileSync(`${hd}/${sid(1)}.jsonl`, asst(sid(1), HEAVY, n) + '\n'),
    (n) => appendFileSync(`${hd}/${sid(0)}/subagents/agent-a0x0.jsonl`, sub('a0x0', n + 1) + '\n'),
    (n) => appendFileSync(`${hd}/${sid(1)}/subagents/agent-a1x0.jsonl`, sub('a1x0', n + 1) + '\n')
  ]
  let n = 0
  const iv = setInterval(() => {
    n++
    for (const t of targets) t(n)
  }, 500)
  setTimeout(
    () => {
      clearInterval(iv)
      console.log('appends', n * targets.length)
      process.exit(0)
    },
    Number(secs) * 1000
  )
}
