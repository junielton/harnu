import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCorroborator,
  parseRegistryCwd,
  slugOfCwd
} from '../../src/main/companion/external-corroboration'

const SID = '22222222-2222-4222-8222-222222222222'
const CWD = '/home/example/work/example-web'
let root: string
let c: ReturnType<typeof createCorroborator>

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'harnu-p4w3-corr-'))
  await fs.mkdir(join(root, 'projects'), { recursive: true })
  await fs.mkdir(join(root, 'sessions'), { recursive: true })
  c = createCorroborator({
    projectsDir: () => join(root, 'projects'),
    registryDir: () => join(root, 'sessions')
  })
})
afterEach(() => fs.rm(root, { recursive: true, force: true }))

describe("corroboration by Harnu's own watchers (§7.5)", () => {
  it('names the project directory the way Claude Code does', () => {
    expect(slugOfCwd('/home/example/work/example-web')).toBe('-home-example-work-example-web')
    expect(slugOfCwd('/a/.hidden/b_c')).toBe('-a--hidden-b-c')
  })

  it('nothing known: not corroborated', async () => {
    expect(await c.corroborates(SID, CWD)).toBe(false)
    expect(await c.corroborates('', CWD)).toBe(false)
  })

  it('a transcript under the project of that cwd corroborates', async () => {
    await fs.mkdir(join(root, 'projects', slugOfCwd(CWD)), { recursive: true })
    await fs.writeFile(join(root, 'projects', slugOfCwd(CWD), `${SID}.jsonl`), '{}\n')
    expect(await c.corroborates(SID, CWD)).toBe(true)
    // The same sid claimed for another cwd is a different project: not corroborated.
    expect(await c.corroborates(SID, '/home/example/other')).toBe(false)
    // Another session id is not corroborated by this transcript.
    expect(await c.corroborates('33333333-3333-4333-8333-333333333333', CWD)).toBe(false)
  })

  it('a registry entry with the same sessionId and cwd corroborates; one without cwd does not', async () => {
    await fs.writeFile(
      join(root, 'sessions', '4242.json'),
      JSON.stringify({ pid: 4242, sessionId: SID, cwd: CWD + '/' })
    )
    expect(await c.corroborates(SID, CWD)).toBe(true)
    await fs.rm(join(root, 'sessions', '4242.json'))
    await fs.writeFile(join(root, 'sessions', '4243.json'), JSON.stringify({ sessionId: SID }))
    expect(await c.corroborates(SID, CWD)).toBe(false)
    await fs.writeFile(
      join(root, 'sessions', '4244.json'),
      JSON.stringify({ sessionId: SID, cwd: '/somewhere/else' })
    )
    expect(await c.corroborates(SID, CWD)).toBe(false)
  })

  it('ignores a registry file that does not parse, and a missing registry directory', async () => {
    await fs.writeFile(join(root, 'sessions', '1.json'), '{ nope')
    expect(await c.corroborates(SID, CWD)).toBe(false)
    await fs.rm(join(root, 'sessions'), { recursive: true })
    expect(await c.corroborates(SID, CWD)).toBe(false)
    expect(parseRegistryCwd('[]')).toBeNull()
    expect(parseRegistryCwd('{"sessionId":""}')).toBeNull()
  })
})
