import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { CommandBridge } from '../src/main/command-bridge'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { createCardFile, readCard, buildManifestDisclosure } from '../src/main/roadmap-ipc'
import { MANIFEST_BOOT_LABELS } from '../src/main/roadmap-core'
import { getShadowLog, clearShadowLog } from '../src/main/responder-registry'

/**
 * T187 (autonomous dispatch): `submit_manifest`'s handler now has TWO entry
 * points into the shared "resolve → stamp → ack" body —
 *
 *  - the operator-Allow path (`ctx.opts.manifest` present, built by
 *    `server.ts`'s `parkMutationConfirm` from a disclosure the human reviewed);
 *  - the NEW silently-allowed path (`ctx.opts` absent — reached when "Ask
 *    before agent actions" is off and the folder isn't blocked), which must
 *    resolve the SAME rows itself, fresh from disk, and treat every requested
 *    slug as checked (there is no operator to uncheck anything).
 *
 * Both must reach the exact same stamp write and ACK shape (AC-1/AC-7/AC-8),
 * and only the silent path fires the T187 Change-3 shadow entry + notify.
 */
const submitManifestHandler = WIRED_TOOLS.find((t) => t.op === 'submit_manifest')!.handler!

const baseCtx = { folders: [], denyFolders: [], bridge: undefined }

function textPayload(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected a text content block')
  return JSON.parse(first.text)
}

async function makeCard(folder: string, slug: string, title: string): Promise<void> {
  const created = await createCardFile(
    folder,
    slug,
    `---\nid: ${slug}\ntitle: ${title}\nstatus: ready\nkind: feature\n---\nDo the thing for ${slug}.`
  )
  expect(created.ok).toBe(true)
}

describe('submitManifestHandler — the silently-allowed path (T187, ctx.opts absent)', () => {
  let folder: string

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-submit-manifest-'))
    clearShadowLog()
  })

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true })
  })

  it('AC-1: stamps every named Ready card `approved` + a body fingerprint, no confirm involved', async () => {
    await makeCard(folder, 'c1', 'Card One')
    await makeCard(folder, 'c2', 'Card Two')

    const res = await submitManifestHandler(
      { folder, cards: [{ slug: 'c1' }, { slug: 'c2' }] },
      { ...baseCtx, folder }
    )
    const payload = textPayload(res)
    expect(payload.ok).toBe(true)
    expect(payload.stamped).toEqual(['c1', 'c2'])
    expect(payload.skipped).toEqual([])
    expect(payload.failed).toBeUndefined()

    for (const slug of ['c1', 'c2']) {
      const found = await readCard(folder, slug)
      expect(found.ok).toBe(true)
      if (found.ok) {
        expect(found.card.approved).toBeTruthy()
        expect(found.card.approvedBodyHash).toBeTruthy()
      }
    }
  })

  it('AC-8: a silent stamp pushes a shadow-log entry naming the folder + slugs', async () => {
    await makeCard(folder, 'c1', 'Card One')

    await submitManifestHandler({ folder, cards: [{ slug: 'c1' }] }, { ...baseCtx, folder })

    const entries = getShadowLog().filter((e) => e.event === 'roadmap:manifest-stamp')
    expect(entries.length).toBe(1)
    expect(entries[0].summary).toContain(folder)
    expect(entries[0].summary).toContain('c1')
  })

  it('fires a best-effort notify via the bridge — never fails the stamp if the bridge rejects', async () => {
    await makeCard(folder, 'c1', 'Card One')
    const dispatch = vi.fn().mockRejectedValue(new Error('no window'))
    const bridge = { dispatch } as unknown as CommandBridge

    const res = await submitManifestHandler(
      { folder, cards: [{ slug: 'c1' }] },
      { ...baseCtx, folder, bridge }
    )

    expect(textPayload(res).ok).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      'notify.push',
      expect.objectContaining({ folderPath: folder })
    )
  })

  it('never fires notify when there is no live bridge (no live renderer window)', async () => {
    await makeCard(folder, 'c1', 'Card One')
    const res = await submitManifestHandler(
      { folder, cards: [{ slug: 'c1' }] },
      { ...baseCtx, folder, bridge: undefined }
    )
    expect(textPayload(res).ok).toBe(true)
  })

  it('refuses the whole batch (no partial stamp) when one card cannot be resolved', async () => {
    await makeCard(folder, 'c1', 'Card One')
    // c2 was never created — buildManifestDisclosure must refuse the batch.
    const res = await submitManifestHandler(
      { folder, cards: [{ slug: 'c1' }, { slug: 'c2' }] },
      { ...baseCtx, folder }
    )
    expect(res.isError).toBe(true)
    const found = await readCard(folder, 'c1')
    expect(found.ok && found.card.approved).toBeFalsy()
  })

  it('BAD_ARGS when no cards are named', async () => {
    const res = await submitManifestHandler({ folder }, { ...baseCtx, folder })
    expect(res.isError).toBe(true)
  })
})

describe('submitManifestHandler — the operator-Allow path (T104, ctx.opts.manifest present)', () => {
  let folder: string

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-submit-manifest-allow-'))
    clearShadowLog()
  })

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true })
  })

  it('stamps ONLY the checked slugs (partial-go), leaving unchecked cards untouched', async () => {
    await makeCard(folder, 'c1', 'Card One')
    await makeCard(folder, 'c2', 'Card Two')
    await makeCard(folder, 'c3', 'Card Three')

    const built = await buildManifestDisclosure(
      folder,
      [{ slug: 'c1' }, { slug: 'c2' }, { slug: 'c3' }],
      MANIFEST_BOOT_LABELS
    )
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const res = await submitManifestHandler(
      {},
      {
        ...baseCtx,
        folder,
        opts: {
          manifest: {
            resolved: built.resolved,
            selectedSlugs: ['c1', 'c3'],
            substrateOverrides: {}
          }
        }
      }
    )
    const payload = textPayload(res)
    expect(payload.ok).toBe(true)
    expect(payload.stamped).toEqual(['c1', 'c3'])
    expect(payload.skipped).toEqual(['c2'])

    const c2 = await readCard(folder, 'c2')
    expect(c2.ok && c2.card.approved).toBeFalsy()

    const entries = getShadowLog()
    expect(entries.some((e) => e.event === 'mcp:submit_manifest')).toBe(true)
    // T187: the silent-path event never fires on the operator-Allow path.
    expect(entries.some((e) => e.event === 'roadmap:manifest-stamp')).toBe(false)
  })

  it('does NOT fire a notify on the operator-Allow path (the operator already saw the confirm)', async () => {
    await makeCard(folder, 'c1', 'Card One')
    const built = await buildManifestDisclosure(folder, [{ slug: 'c1' }], MANIFEST_BOOT_LABELS)
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const dispatch = vi.fn().mockResolvedValue({})
    const bridge = { dispatch } as unknown as CommandBridge

    await submitManifestHandler(
      {},
      {
        ...baseCtx,
        folder,
        bridge,
        opts: {
          manifest: { resolved: built.resolved, selectedSlugs: ['c1'], substrateOverrides: {} }
        }
      }
    )
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('BAD_ARGS when the manifest carries no disclosed rows (never disclosed)', async () => {
    const res = await submitManifestHandler(
      {},
      {
        ...baseCtx,
        folder,
        opts: { manifest: { resolved: [], selectedSlugs: [], substrateOverrides: {} } }
      }
    )
    expect(res.isError).toBe(true)
  })
})
