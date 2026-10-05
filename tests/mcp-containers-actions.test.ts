import { describe, it, expect } from 'vitest'
import {
  ACT_VERBS,
  type ActResult,
  type AgentActVerb,
  type StackActResult
} from '../src/main/containers/containers-wire'
import { shellQuote } from '../src/main/containers/containers-journal'
import {
  blockedStackIds,
  CONTAINERS_ACT_OPS,
  containersActAck,
  containersConfirmPrompt,
  containersListing
} from '../src/main/mcp/containers-listing'
import { MCP_OPS, MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { available, MAIN, NOW, stackRow, WT } from './containers-fixtures'

/**
 * T329 — the pure half of the Containers action verbs: the parity between the
 * main-process action function and the MCP catalog, the ACK shaping and the
 * operator's confirm copy. The verbs driven end to end live in
 * `mcp-containers-actions-handler.test.ts`.
 */

const HOME = '/home/dev'

/** `ActVerb` minus the operator-only `sweep`, spelled out so the exclusion is visible. */
const AGENT_ACT_VERBS: AgentActVerb[] = ['stop', 'start', 'remove']

describe('Containers action parity (T329 AC-6, T340 AC-7)', () => {
  it('the action function accepts stop, start, remove and the operator-only sweep', () => {
    expect([...ACT_VERBS].sort()).toEqual(['remove', 'start', 'stop', 'sweep'])
  })

  it('sweep is deliberately excluded: it is the one verb no MCP op exposes', () => {
    // T340: a sweep clears the whole "Needs you" list in one operator gesture.
    // An agent stops and removes stacks one at a time, so the map is checked
    // against `AgentActVerb` (ActVerb minus sweep) and the compiler — not a
    // comment — keeps the hole from closing by accident.
    expect(Object.keys(CONTAINERS_ACT_OPS)).not.toContain('sweep')
    expect(AGENT_ACT_VERBS).not.toContain('sweep')
    expect(Object.values(CONTAINERS_ACT_OPS).join(' ')).not.toContain('sweep')
    expect(MCP_OPS.filter((op) => op.includes('sweep'))).toEqual([])
  })

  it('every verb an agent may drive maps to exactly one mutating containers MCP op', () => {
    expect(Object.keys(CONTAINERS_ACT_OPS).sort()).toEqual([...AGENT_ACT_VERBS].sort())
    const ops = Object.values(CONTAINERS_ACT_OPS)
    expect(new Set(ops).size).toBe(ops.length)
    for (const op of ops) {
      expect(MCP_OPS).toContain(op)
      expect(MCP_TOOLS.find((t) => t.op === op)?.mutates).toBe(true)
    }
  })

  it('every mutating containers op in the catalog maps back to one verb', () => {
    const catalog = MCP_TOOLS.filter((t) => t.mutates && t.op.endsWith('_containers'))
      .map((t) => t.op)
      .sort()
    expect(catalog).toEqual(Object.values(CONTAINERS_ACT_OPS).sort())
  })
})

function stackResult(stack: string, over: Partial<StackActResult> = {}): StackActResult {
  return {
    stack,
    ok: true,
    containerIds: [],
    freedRamBytes: 0,
    freedVolumeBytes: 0,
    portsReleased: [],
    removedContainers: [],
    removedVolumes: [],
    keptVolumes: [],
    ...over
  }
}

function actResult(over: Partial<ActResult> = {}): ActResult {
  return { ok: true, verb: 'stop', results: [], tombstone: null, ...over }
}

describe('containersActAck', () => {
  it('merges the folder block with the action results, in the agent’s order', () => {
    const ack = containersActAck('stop', {
      requested: ['b', 'a', 'b'],
      blocked: ['b'],
      result: actResult({ results: [stackResult('a', { freedRamBytes: 5, portsReleased: [80] })] }),
      home: HOME
    })
    expect(ack.isError).toBe(true)
    expect(ack.payload).toEqual({
      ok: false,
      results: [
        {
          stack: 'b',
          ok: false,
          freedBytes: 0,
          portsReleased: [],
          error: 'FOLDER_NOT_ALLOWED',
          message: expect.any(String)
        },
        { stack: 'a', ok: true, freedBytes: 5, portsReleased: [80] }
      ]
    })
  })

  it('is never ok when every stack was blocked and nothing ran', () => {
    const ack = containersActAck('start', {
      requested: ['a'],
      blocked: ['a'],
      result: null,
      home: HOME
    })
    expect(ack.isError).toBe(true)
    expect(ack.payload).toMatchObject({ ok: false, results: [{ error: 'FOLDER_NOT_ALLOWED' }] })
  })

  it('an action whose journal write failed is not ok, and says why', () => {
    const ack = containersActAck('stop', {
      requested: ['a'],
      blocked: [],
      result: actResult({
        ok: false,
        message: 'journal write failed: EACCES',
        results: [stackResult('a')]
      }),
      home: HOME
    })
    expect(ack.isError).toBe(true)
    expect(ack.payload).toMatchObject({ ok: false, message: 'journal write failed: EACCES' })
  })

  it('DOCKER_UNAVAILABLE is a request-level refusal, redacted', () => {
    const ack = containersActAck('stop', {
      requested: ['a'],
      blocked: [],
      result: actResult({
        ok: false,
        error: 'DOCKER_UNAVAILABLE',
        message: `permission denied: ${HOME}/.docker/run/docker.sock`
      }),
      home: HOME
    })
    expect(ack.isError).toBe(true)
    expect(ack.payload).toMatchObject({ ok: false, error: 'DOCKER_UNAVAILABLE' })
    expect(JSON.stringify(ack.payload)).not.toContain(`${HOME}/`)
    expect(ack.payload).not.toHaveProperty('results')
  })

  it('remove: the restore hint shows the directory as an alias, and is omitted when null', () => {
    const tombstone = {
      at: NOW,
      actor: 'agent' as const,
      verb: 'remove' as const,
      stacks: [
        {
          stack: 'wave-1',
          name: 'wave-1',
          path: WT,
          containerIds: ['c1'],
          freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 }
        }
      ],
      restoreHint: `docker compose --project-directory ${WT} up -d`
    }
    const removed = stackResult('wave-1', { containerIds: ['c1'], removedContainers: ['c1'] })
    const withHint = containersActAck('remove', {
      requested: ['wave-1'],
      blocked: [],
      result: actResult({ verb: 'remove', results: [removed], tombstone }),
      home: HOME
    })
    expect(withHint.payload).toMatchObject({
      ok: true,
      restoreHint: 'docker compose --project-directory <PROJ-231-wave-1> up -d'
    })
    const noHint = containersActAck('remove', {
      requested: ['wave-1'],
      blocked: [],
      result: actResult({
        verb: 'remove',
        results: [removed],
        tombstone: { ...tombstone, restoreHint: null }
      }),
      home: HOME
    })
    expect(noHint.payload).not.toHaveProperty('restoreHint')
  })
})

describe('restore-hint redaction holds for shell-quoted paths (T329 AC-9)', () => {
  function removeTombstone(dir: string) {
    return {
      at: NOW,
      actor: 'agent' as const,
      verb: 'remove' as const,
      stacks: [
        {
          stack: 's',
          name: 's',
          path: dir,
          containerIds: ['c1'],
          freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 }
        }
      ],
      // What `restoreHintForRemove` writes: the path as one shell word.
      restoreHint: `docker compose --project-directory ${shellQuote(dir)} up -d`
    }
  }

  it.each([
    ["/tmp/it's-a-worktree", "<it's-a-worktree>"],
    ['/tmp/my worktree', '<my worktree>'],
    [WT, '<PROJ-231-wave-1>']
  ])('%s shows as %s in list_containers.recent and in the remove ACK', (dir, shown) => {
    const tombstone = removeTombstone(dir)
    const expected = `docker compose --project-directory ${shown} up -d`

    const listed = containersListing(
      { ...available([]), recent: [tombstone] },
      { denyFolders: [], home: HOME }
    )
    expect(listed.recent[0]!.restoreHint).toBe(expected)
    expect(JSON.stringify(listed)).not.toContain(dir)

    const ack = containersActAck('remove', {
      requested: ['s'],
      blocked: [],
      result: actResult({
        verb: 'remove',
        results: [stackResult('s', { containerIds: ['c1'], removedContainers: ['c1'] })],
        tombstone
      }),
      home: HOME
    })
    expect(ack.payload).toMatchObject({ restoreHint: expected })
    expect(JSON.stringify(ack.payload)).not.toContain(dir)
  })
})

describe('blockedStackIds', () => {
  const snap = available([
    stackRow({
      id: 'www',
      verdict: 'protected',
      attribution: {
        rung: 'compose-label',
        path: MAIN,
        folderPath: MAIN,
        folderKind: 'main-checkout'
      }
    }),
    stackRow({ id: 'wave-1', verdict: 'zombie' }),
    stackRow({ id: 'stray', verdict: 'unknown' })
  ])

  it('names the requested stacks a blocked folder covers, and nothing else', () => {
    expect(blockedStackIds(snap, ['www', 'wave-1', 'stray', 'nope'], [WT], HOME)).toEqual([
      'wave-1'
    ])
    // A block covers its subtree: blocking the repo blocks its worktrees.
    expect(blockedStackIds(snap, ['www', 'wave-1'], [MAIN], HOME)).toEqual(['www', 'wave-1'])
    expect(blockedStackIds(snap, ['www', 'wave-1'], [], HOME)).toEqual([])
  })
})

describe('containersConfirmPrompt', () => {
  const snap = available([
    stackRow({
      id: 'wave-3',
      verdict: 'zombie',
      running: false,
      volumes: [
        { name: 'wave-3_data', sizeBytes: 1, shared: false },
        { name: 'shared_cache', sizeBytes: 1, shared: true }
      ]
    }),
    stackRow({ id: 'busy', verdict: 'active' })
  ])

  it('remove names the stack, its verdict and path, and the volumes it would delete', () => {
    const prompt = containersConfirmPrompt(
      'remove_containers',
      { stack: 'wave-3', removeVolumes: true },
      snap
    )
    expect(prompt).toContain('wave-3 — zombie, stopped')
    expect(prompt).toContain(WT)
    expect(prompt).toContain('wave-3_data')
    expect(prompt).not.toContain('shared_cache')
    expect(prompt).toContain('no undo')
  })

  it('remove without removeVolumes says the volumes are kept', () => {
    const prompt = containersConfirmPrompt('remove_containers', { stack: 'wave-3' }, snap)
    expect(prompt).toContain('Keeps its volumes')
  })

  it('a force-stop says what force reaches', () => {
    const prompt = containersConfirmPrompt(
      'stop_containers',
      { stacks: ['busy'], force: true },
      snap
    )
    expect(prompt).toContain('Force-stop 1 Docker stack')
    expect(prompt).toContain('busy — active, running')
    expect(prompt).toContain('ACTIVE')
    expect(prompt).toContain('PROTECTED')
  })

  it('a plain stop and a start read honestly under "Ask before agent actions"', () => {
    expect(containersConfirmPrompt('stop_containers', { stacks: ['busy'] }, snap)).toMatch(
      /^Stop 1 Docker stack for an agent/
    )
    expect(
      containersConfirmPrompt('start_containers', { stacks: ['wave-3', 'busy'] }, snap)
    ).toMatch(/^Start 2 Docker stacks for an agent/)
  })

  it('a stack missing from the last scan, or no scan at all, says so', () => {
    expect(containersConfirmPrompt('remove_containers', { stack: 'nope' }, snap)).toContain(
      "nope — not in Harnu's last scan"
    )
    expect(containersConfirmPrompt('stop_containers', { stacks: ['busy'] }, null)).toContain(
      "busy — not in Harnu's last scan"
    )
  })
})
