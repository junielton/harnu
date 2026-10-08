import { describe, it, expect } from 'vitest'
import {
  createJobQueue,
  type GcJobDone,
  type GcJobProgress,
  type JobReporter
} from '../src/main/gc/gc-jobs-core'
import { runBatch, type GcItemResult, type GcOps } from '../src/main/gc/pipeline-core'
import { bundle } from './gc-fixtures'

const ok = (id: string, freedBytes = 10): GcItemResult => ({
  id,
  ok: true,
  haltedAt: null,
  freedBytes
})

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness() {
  const progress: GcJobProgress[] = []
  const done: GcJobDone[] = []
  let n = 0
  const queue = createJobQueue({
    newId: () => `job-${++n}`,
    emitProgress: (p) => progress.push(structuredClone(p)),
    emitDone: (d) => done.push(structuredClone(d))
  })
  return { queue, progress, done }
}

/** A run that finishes each item only when the test releases it. */
function gated(ids: string[]) {
  const gates = ids.map(() => deferred())
  const started: string[] = []
  const run = async (r: JobReporter): Promise<GcItemResult[]> => {
    const out: GcItemResult[] = []
    for (const [i, id] of ids.entries()) {
      r.onStart(id)
      started.push(id)
      await gates[i]!.promise
      const res = ok(id, 100)
      out.push(res)
      r.onItem(res)
    }
    return out
  }
  return { run, gates, started }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('job queue: submit returns before the batch finishes (AC-4)', () => {
  it('hands back a job id synchronously while the run is still going', async () => {
    const { queue, done } = harness()
    const g = gated(['a', 'b'])
    const { jobId } = queue.submit('manual', ['a', 'b'], g.run)
    expect(jobId).toBe('job-1')
    await tick()
    expect(done).toEqual([])
    expect(queue.jobs()[0]).toMatchObject({ jobId, state: 'running', total: 2, done: 0 })
    g.gates.forEach((x) => x.resolve())
  })

  it('emits exactly one progress event per finished item, then one terminal done', async () => {
    const { queue, progress, done } = harness()
    const g = gated(['a', 'b', 'c'])
    const { finished } = queue.submit('manual', ['a', 'b', 'c'], g.run)
    for (const gate of g.gates) {
      gate.resolve()
      await tick()
    }
    await finished
    expect(progress).toHaveLength(3)
    expect(progress.map((p) => p.done)).toEqual([1, 2, 3])
    expect(progress.map((p) => p.total)).toEqual([3, 3, 3])
    expect(progress.map((p) => p.freedBytes)).toEqual([100, 200, 300])
    expect(progress[2]!.results.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({
      jobId: 'job-1',
      done: 3,
      total: 3,
      freedBytes: 300,
      error: null
    })
  })

  it('names the next item as current, and null after the last', async () => {
    const { queue, progress } = harness()
    const g = gated(['a', 'b'])
    const { finished } = queue.submit('manual', ['a', 'b'], g.run)
    g.gates.forEach((x) => x.resolve())
    await finished
    expect(progress.map((p) => p.current)).toEqual(['b', null])
  })

  it('shows the in-flight item in jobs() so a reloaded renderer can re-attach', async () => {
    const { queue } = harness()
    const g = gated(['a', 'b'])
    queue.submit('manual', ['a', 'b'], g.run)
    await tick()
    expect(queue.jobs()[0]).toMatchObject({ current: 'a', state: 'running' })
    g.gates[0]!.resolve()
    await tick()
    expect(queue.jobs()[0]).toMatchObject({ current: 'b', done: 1 })
    g.gates[1]!.resolve()
  })
})

describe('job queue: one job at a time (AC-4)', () => {
  it('queues a second request instead of running it in parallel', async () => {
    const { queue } = harness()
    const first = gated(['a'])
    const second = gated(['b'])
    queue.submit('autopilot', ['a'], first.run)
    const { jobId } = queue.submit('manual', ['b'], second.run)
    await tick()
    expect(first.started).toEqual(['a'])
    expect(second.started).toEqual([])
    expect(queue.jobs().find((j) => j.jobId === jobId)?.state).toBe('queued')
    expect(queue.busy()).toBe(true)

    first.gates[0]!.resolve()
    await tick()
    expect(second.started).toEqual(['b'])
    expect(queue.jobs().find((j) => j.jobId === jobId)?.state).toBe('running')
    second.gates[0]!.resolve()
    await tick()
    expect(queue.busy()).toBe(false)
  })

  it('runs queued jobs in submission order', async () => {
    const { queue, done } = harness()
    const order: string[] = []
    for (const name of ['x', 'y', 'z']) {
      queue.submit('manual', [name], async (r) => {
        r.onStart(name)
        order.push(name)
        const res = ok(name)
        r.onItem(res)
        return [res]
      })
    }
    await queue.idle()
    expect(order).toEqual(['x', 'y', 'z'])
    expect(done.map((d) => d.jobId)).toEqual(['job-1', 'job-2', 'job-3'])
  })

  it('waits for beforeRun before starting a job', async () => {
    const gate = deferred()
    const log: string[] = []
    const queue = createJobQueue({
      newId: () => 'j',
      emitProgress: () => undefined,
      emitDone: () => undefined,
      beforeRun: async () => {
        log.push('before')
        await gate.promise
      }
    })
    queue.submit('manual', ['a'], async () => {
      log.push('run')
      return [ok('a')]
    })
    await tick()
    expect(log).toEqual(['before'])
    gate.resolve()
    await queue.idle()
    expect(log).toEqual(['before', 'run'])
  })
})

describe('job queue: exclusive wrapper (delta 1, item 4)', () => {
  it('runs beforeRun and the job inside the wrapper, and leaves it afterwards', async () => {
    const log: string[] = []
    const queue = createJobQueue({
      newId: () => 'j',
      emitProgress: () => undefined,
      emitDone: () => undefined,
      around: async (work) => {
        log.push('enter')
        await work()
        log.push('exit')
      }
    })
    queue.submit('manual', ['a'], async () => {
      log.push('run')
      return [ok('a')]
    })
    await queue.idle()
    expect(log).toEqual(['enter', 'run', 'exit'])
  })

  it('still ends the job when the wrapper itself fails', async () => {
    const { done: _unused } = harness()
    const finished: GcJobDone[] = []
    const queue = createJobQueue({
      newId: () => 'j',
      emitProgress: () => undefined,
      emitDone: (d) => finished.push(d),
      around: async () => {
        throw new Error('lock broke')
      }
    })
    queue.submit('manual', ['a'], async () => [ok('a')])
    await queue.idle()
    expect(finished[0]).toMatchObject({ error: 'lock broke' })
  })

  it('holds the next job until the wrapper has released', async () => {
    const log: string[] = []
    let n = 0
    const queue = createJobQueue({
      newId: () => `j${++n}`,
      emitProgress: () => undefined,
      emitDone: () => undefined,
      around: async (work) => {
        log.push('enter')
        await work()
        log.push('exit')
      }
    })
    queue.submit('manual', ['a'], async () => {
      log.push('run a')
      return []
    })
    queue.submit('manual', ['b'], async () => {
      log.push('run b')
      return []
    })
    await queue.idle()
    expect(log).toEqual(['enter', 'run a', 'exit', 'enter', 'run b', 'exit'])
  })
})

describe('job queue: it always settles (delta 3, item 5)', () => {
  it('frees the queue and settles the job when emitDone throws', async () => {
    const ran: string[] = []
    let n = 0
    const queue = createJobQueue({
      newId: () => `j${++n}`,
      emitProgress: () => undefined,
      emitDone: (d) => {
        if (d.jobId === 'j1') throw new Error('renderer is gone')
      }
    })
    const first = queue.submit('manual', ['a'], async () => {
      ran.push('a')
      return []
    })
    const second = queue.submit('manual', ['b'], async () => {
      ran.push('b')
      return []
    })
    const timeout = new Promise<string>((res) => setTimeout(() => res('hung'), 500))
    expect(await Promise.race([first.finished.then(() => 'settled'), timeout])).toBe('settled')
    expect(await Promise.race([second.finished.then(() => 'settled'), timeout])).toBe('settled')
    await queue.idle()
    expect(ran).toEqual(['a', 'b'])
    expect(queue.busy()).toBe(false)
  })

  it('does not leave an unhandled rejection behind', async () => {
    const seen: unknown[] = []
    const onRejection = (e: unknown): void => void seen.push(e)
    process.on('unhandledRejection', onRejection)
    try {
      const queue = createJobQueue({
        newId: () => 'j',
        emitProgress: () => undefined,
        emitDone: () => {
          throw new Error('boom')
        }
      })
      queue.submit('manual', [], async () => [])
      await queue.idle()
      await new Promise((r) => setTimeout(r, 20))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('a progress event that throws does not fail the job or skip its other items', async () => {
    const results: string[] = []
    const queue = createJobQueue({
      newId: () => 'j',
      emitProgress: () => {
        throw new Error('window closed')
      },
      emitDone: (d) => results.push(...d.results.map((r) => r.id))
    })
    const { finished } = queue.submit('manual', ['a', 'b'], async (r) => {
      r.onItem(ok('a'))
      r.onItem(ok('b'))
      return [ok('a'), ok('b')]
    })
    const done = await finished
    expect(done.error).toBeNull()
    expect(results).toEqual(['a', 'b'])
  })

  it('the cycle that awaits a job whose emitDone threw still returns', async () => {
    let n = 0
    const queue = createJobQueue({
      newId: () => `j${++n}`,
      emitProgress: () => undefined,
      emitDone: () => {
        throw new Error('boom')
      }
    })
    const { finished } = queue.submit('autopilot', ['a'], async (r) => {
      const res = ok('a')
      r.onItem(res)
      return [res]
    })
    expect((await finished).results.map((r) => r.id)).toEqual(['a'])
  })
})

describe('job queue: failure and bookkeeping', () => {
  it('still ends with a done event when the run throws, keeping the results so far', async () => {
    const { queue, done } = harness()
    const { finished } = queue.submit('manual', ['a', 'b'], async (r) => {
      r.onItem(ok('a'))
      throw new Error('docker went away')
    })
    const result = await finished
    expect(result.error).toBe('docker went away')
    expect(done[0]).toMatchObject({ done: 1, total: 2, error: 'docker went away' })
    expect(done[0]!.results.map((r) => r.id)).toEqual(['a'])
  })

  it('keeps going with the next job after one threw', async () => {
    const { queue, done } = harness()
    queue.submit('manual', ['a'], async () => {
      throw new Error('boom')
    })
    queue.submit('manual', ['b'], async (r) => {
      const res = ok('b')
      r.onItem(res)
      return [res]
    })
    await queue.idle()
    expect(done.map((d) => d.error)).toEqual(['boom', null])
  })

  it('keeps finished jobs visible for a re-attach, newest last, and caps the history', async () => {
    const { queue } = harness()
    for (let i = 0; i < 8; i++) queue.submit('manual', [`i${i}`], async () => [])
    await queue.idle()
    const finished = queue.jobs().filter((j) => j.state === 'done')
    expect(finished.length).toBeLessThanOrEqual(5)
    expect(finished.at(-1)?.jobId).toBe('job-8')
  })

  it('records the kind so the renderer can tell autopilot from manual', async () => {
    const { queue, done } = harness()
    queue.submit('autopilot', [], async () => [])
    await queue.idle()
    expect(done[0]!.kind).toBe('autopilot')
  })
})

describe('runBatch hooks: the per-item progress source', () => {
  const ops: GcOps = {
    reprobe: async () => ({ ok: true }),
    stopStacks: async () => undefined,
    removeContainers: async () => undefined,
    removeVolumes: async () => undefined,
    dropDeps: async () => 5,
    recheck: async () => ({ ok: true }),
    cleanGit: async () => undefined
  }

  it('reports each bundle before it runs and its result after, in order', async () => {
    const log: string[] = []
    const bs = [bundle('/ws/wt/a', 'ready'), bundle('/ws/wt/b', 'ready')]
    const results = await runBatch(
      bs,
      ops,
      { removeVolumes: true },
      {
        onStart: (b) => log.push(`start ${b.item.path}`),
        onItem: (r, b) => log.push(`done ${b.item.path} ${r.ok}`)
      }
    )
    expect(results).toHaveLength(2)
    expect(log).toEqual([
      'start /ws/wt/a',
      'done /ws/wt/a true',
      'start /ws/wt/b',
      'done /ws/wt/b true'
    ])
  })

  it('behaves as before without hooks', async () => {
    const results = await runBatch([bundle('/ws/wt/a', 'ready')], ops, { removeVolumes: true })
    expect(results.map((r) => r.ok)).toEqual([true])
  })
})
