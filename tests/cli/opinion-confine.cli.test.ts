import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { opinionArgv } from '../../src/main/gc/opinion-core'

// What the advisor can READ against the real CLI (T444 delta 4, item 2). With no blanket allow rule the
// CLI confines Read, Grep and Glob to the folder it runs in and refuses everything else, symlinks out
// of the folder included. This needs a model turn (the model has to try the reads), so it uses the
// account's credentials for one cheap Haiku call whose whole roster is Read, Grep and Glob: no tool
// that reaches the account exists in the session. Gated separately from the hermetic suites:
// `HARNU_WITH_CLI_LIVE=1`.

const LIVE = Boolean(process.env.HARNU_WITH_CLI_LIVE)

interface Call {
  name: string
  input: Record<string, unknown>
  error: boolean
  text: string
}

async function tryReads(prompt: string, cwd: string): Promise<Call[]> {
  const flags = opinionArgv({ model: 'haiku', effort: 'low' }).map((a) =>
    a === 'json' ? 'stream-json' : a
  )
  flags.push('--verbose')
  const env = { ...process.env } as Record<string, string>
  delete env.HARNU_SPAWN_TOKEN
  const out = await new Promise<string>((resolve) => {
    const child = spawn('claude', flags, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 90_000
    })
    let buf = ''
    child.stdout.on('data', (d: Buffer) => (buf += d.toString()))
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
    child.on('close', () => resolve(buf))
    child.on('error', () => resolve(buf))
  })
  const calls = new Map<string, Call>()
  for (const line of out.split('\n')) {
    let d: { type?: string; message?: { content?: unknown[] } }
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    for (const c of (d.message?.content ?? []) as Record<string, unknown>[]) {
      if (d.type === 'assistant' && c.type === 'tool_use') {
        calls.set(String(c.id), {
          name: String(c.name),
          input: c.input as Record<string, unknown>,
          error: false,
          text: ''
        })
      }
      if (d.type === 'user' && c.type === 'tool_result') {
        const call = calls.get(String(c.tool_use_id))
        if (call) {
          call.error = c.is_error === true
          call.text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
        }
      }
    }
  }
  return [...calls.values()]
}

describe.skipIf(!LIVE)(
  'the advisor session reads only inside the folder it runs in (real CLI)',
  () => {
    it('reads inside, and is refused outside, for Read, Grep, Glob and a symlink out', async () => {
      const root = mkdtempSync(join(tmpdir(), 'harnu-advisor-confine-'))
      try {
        const inside = join(root, 'inside')
        const outside = join(root, 'outside')
        mkdirSync(inside)
        mkdirSync(outside)
        writeFileSync(join(inside, 'ok.txt'), 'INSIDE-OK\n')
        writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n')
        symlinkSync(outside, join(inside, 'link'))
        const prompt = [
          'Do exactly these tool calls and report each result:',
          `(1) Read ${inside}/ok.txt`,
          `(2) Read ${outside}/secret.txt`,
          `(3) Grep for OUTSIDE in directory ${outside}`,
          `(4) Glob pattern '*' with path ${outside}`,
          `(5) Read ${inside}/link/secret.txt (a symlink inside the folder that points outside)`
        ].join('\n')
        const calls = await tryReads(prompt, inside)
        const read = (p: string): Call | undefined =>
          calls.find((c) => c.name === 'Read' && String(c.input.file_path).includes(p))
        expect(read('ok.txt')?.error).toBe(false)
        expect(read('ok.txt')?.text).toContain('INSIDE-OK')
        expect(read(`${outside}/secret.txt`)?.error).toBe(true)
        expect(calls.filter((c) => c.name === 'Grep').every((c) => c.error)).toBe(true)
        expect(calls.filter((c) => c.name === 'Glob').every((c) => c.error)).toBe(true)
        expect(read('link/secret.txt')?.error).toBe(true)
        for (const c of calls) expect(c.text).not.toContain('OUTSIDE-SECRET')
        expect(calls.map((c) => c.name).every((n) => ['Read', 'Grep', 'Glob'].includes(n))).toBe(
          true
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 120_000)
  }
)
