/**
 * BUG-308 review: Your move reads the companion audit log that another module writes. This pins
 * the reader to the real writer: a change of file name, directory or record shape fails here
 * instead of silently switching the check off.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AUDIT_MAX_BYTES,
  bindingAuditRecord,
  serializeAudit
} from '../../src/main/companion/audit-core'
import { appendAudit, configureAuditDir } from '../../src/main/companion/audit-log'
import { companionAuditFiles, createAgentOrigins } from '../../src/main/your-move/agent-origin'

let userData: string
beforeEach(async () => {
  userData = await mkdtemp(path.join(os.tmpdir(), 'your-move-audit-'))
  await mkdir(path.join(userData, 'companion'))
  configureAuditDir(path.join(userData, 'companion'))
})
afterEach(async () => {
  configureAuditDir(null)
  await rm(userData, { recursive: true, force: true })
})

const bound = (sid: string): ReturnType<typeof bindingAuditRecord> =>
  bindingAuditRecord('bound', { sessionKey: sid, sid, profile: 'interactive', trust: 'agent' }, 1)

describe('the companion audit log as the writer leaves it', () => {
  it('is found and read, in both generations', async () => {
    await writeFile(
      path.join(userData, 'companion', 'audit.ndjson'),
      serializeAudit(bound('rotated')) + `${'x'.repeat(AUDIT_MAX_BYTES)}\n`
    )
    appendAudit(bound('current')) // over the cap: the writer rotates first
    const origins = createAgentOrigins({
      file: path.join(userData, 'agents.json'),
      auditFiles: companionAuditFiles(userData),
      live: () => undefined,
      now: () => 1_000_000
    })
    expect(await origins.isAgentSpawned('current')).toBe(true)
    expect(await origins.isAgentSpawned('rotated')).toBe(true)
    await origins.idle()
  })

  it('lives in the directory the companion host configures', async () => {
    const host = await readFile(path.join(__dirname, '../../src/main/companion/host.ts'), 'utf8')
    expect(host).toContain("configureAuditDir(join(userData, 'companion'))")
  })
})
