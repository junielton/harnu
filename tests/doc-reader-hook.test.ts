import { describe, it, expect, afterEach, vi } from 'vitest'
import { request } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * T2: the doc-reader gate as shipped — the Hook Bridge route, the answer it gives, and the
 * staged hook's shape. The gate's own decisions are pinned in `doc-reader-gate-core.test.ts`.
 */

let userDataDir = mkdtempSync(join(tmpdir(), 'harnu-docread-ud-'))
vi.mock('electron', () => ({ app: { getPath: () => userDataDir, isPackaged: false } }))

import { startHookServer } from '../src/main/hook-bridge'
import {
  answerDocReadHook,
  countFileLines,
  docReaderHooksJson,
  docReaderHookUrl,
  docReaderStampPart,
  minLinesFromRoute
} from '../src/main/doc-reader/hook'

const dir = mkdtempSync(join(tmpdir(), 'harnu-docread-'))
const big = join(dir, 'big.md')
const small = join(dir, 'small.md')
writeFileSync(big, 'line\n'.repeat(1200))
writeFileSync(small, 'line\n'.repeat(40))

const readCall = (
  file_path: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  session_id: 's1',
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path, ...extra },
  cwd: dir
})

function post(
  port: number,
  path: string,
  body: unknown
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('answerDocReadHook', () => {
  it('denies a whole Read of a large doc and names the agent', async () => {
    const out = JSON.parse(await answerDocReadHook(350, readCall(big)))
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('harnu:doc-reader')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('1200 lines')
  })

  it('denies a whole `cat` of a large doc', async () => {
    const body = { tool_name: 'Bash', tool_input: { command: `cat ${big}` }, cwd: dir }
    expect(
      JSON.parse(await answerDocReadHook(350, body)).hookSpecificOutput.permissionDecision
    ).toBe('deny')
  })

  it('allows a capped Read, a small doc, a subagent, and anything that is not a doc read', async () => {
    expect(await answerDocReadHook(350, readCall(big, { offset: 10, limit: 350 }))).toBe('{}')
    expect(await answerDocReadHook(350, readCall(small))).toBe('{}')
    expect(
      await answerDocReadHook(350, {
        ...readCall(big),
        agent_id: 'a1',
        agent_type: 'harnu:doc-reader'
      })
    ).toBe('{}')
    expect(await answerDocReadHook(350, { tool_name: 'Bash', tool_input: { command: 'ls' } })).toBe(
      '{}'
    )
  })

  it('applies the threshold it is given', async () => {
    expect(await answerDocReadHook(1500, readCall(big))).toBe('{}')
  })

  it('never touches the disk for a call that cannot be denied', async () => {
    const counter = vi.fn(async () => 9999)
    await answerDocReadHook(350, readCall(big, { limit: 20 }), counter)
    await answerDocReadHook(350, { tool_name: 'Grep', tool_input: {} }, counter)
    await answerDocReadHook(350, readCall(join(dir, 'code.ts')), counter)
    expect(counter).not.toHaveBeenCalled()
  })

  it('fails open when the file is missing or the counter throws', async () => {
    expect(await answerDocReadHook(350, readCall(join(dir, 'nope.md')))).toBe('{}')
    expect(
      await answerDocReadHook(350, readCall(big), async () => {
        throw new Error('boom')
      })
    ).toBe('{}')
  })
})

describe('countFileLines', () => {
  it('counts newlines, a trailing partial line, and refuses a directory', async () => {
    const f = join(dir, 'partial.md')
    writeFileSync(f, 'a\nb\nc')
    expect(await countFileLines(f)).toBe(3)
    expect(await countFileLines(big)).toBe(1200)
    expect(await countFileLines(dir)).toBeNull()
  })
})

describe('the staged hook', () => {
  it('is one http PreToolUse hook on Read|Bash that bakes in the clamped threshold', () => {
    const json = JSON.parse(docReaderHooksJson(4321, 'tok', 500))
    expect(json.hooks.PreToolUse).toEqual([
      {
        matcher: 'Read|Bash',
        hooks: [{ type: 'http', url: 'http://127.0.0.1:4321/docread/tok/500', timeout: 5 }]
      }
    ])
    expect(docReaderHookUrl(1, 't', 3)).toBe('http://127.0.0.1:1/docread/t/50')
  })

  it('has a stamp that moves with the bridge and the threshold and never holds the token', () => {
    const a = docReaderStampPart(1, 'secret-token', 350)
    expect(a).not.toContain('secret-token')
    expect(docReaderStampPart(2, 'secret-token', 350)).not.toBe(a)
    expect(docReaderStampPart(1, 'other', 350)).not.toBe(a)
    expect(docReaderStampPart(1, 'secret-token', 400)).not.toBe(a)
  })

  it('reads the threshold off the route, defaulting anything malformed', () => {
    expect(minLinesFromRoute('600')).toBe(600)
    expect(minLinesFromRoute('abc')).toBe(350)
    expect(minLinesFromRoute(undefined)).toBe(350)
  })

  it('ships the same agent the T1 eval measured', () => {
    const repo = join(__dirname, '..')
    expect(
      readFileSync(join(repo, 'resources/skills/features/doc-reader/agents/doc-reader.md'), 'utf8')
    ).toBe(readFileSync(join(repo, 'evals/doc-reader/agents/doc-reader.md'), 'utf8'))
  })
})

describe('Hook Bridge /docread route', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (close) await close()
    close = null
    userDataDir = mkdtempSync(join(tmpdir(), 'harnu-docread-ud-'))
  })

  it('answers the gate decision with the threshold from the path', async () => {
    const s = await startHookServer(() => {}, 'tok', {
      docRead: (minLines, body) => answerDocReadHook(minLines, body)
    })
    close = s.close
    const denied = await post(s.port, '/docread/tok/350', readCall(big))
    expect(denied.status).toBe(200)
    expect(JSON.parse(denied.text).hookSpecificOutput.permissionDecision).toBe('deny')
    expect((await post(s.port, '/docread/tok/2000', readCall(big))).text).toBe('{}')
  })

  it('refuses a wrong token and fails open on a bad body or a throwing handler', async () => {
    const s = await startHookServer(() => {}, 'tok', {
      docRead: async () => {
        throw new Error('boom')
      }
    })
    close = s.close
    expect((await post(s.port, '/docread/nope/350', readCall(big))).status).toBe(403)
    expect(await post(s.port, '/docread/tok/350', readCall(big))).toEqual({
      status: 200,
      text: '{}'
    })
    expect(await post(s.port, '/docread/tok/350', 'not json')).toEqual({ status: 200, text: '{}' })
  })

  it('answers {} when no handler is wired', async () => {
    const s = await startHookServer(() => {}, 'tok')
    close = s.close
    expect(await post(s.port, '/docread/tok/350', readCall(big))).toEqual({
      status: 200,
      text: '{}'
    })
  })
})
