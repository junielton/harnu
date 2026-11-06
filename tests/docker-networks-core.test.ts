import { describe, expect, it } from 'vitest'
import {
  externalNetworkNamesOf,
  parseNetworkInspect,
  planEmptyComposeNetworks,
  type DockerNetworkFact,
  type ExternalDeclarations
} from '../src/main/containers/docker-networks-core'
import { COMPOSE_PROJECT_LABEL } from '../src/main/containers/containers-core'
import { composeContainer, container } from './containers-fixtures'

const net = (name: string, over: Partial<DockerNetworkFact> = {}): DockerNetworkFact => ({
  id: `id-${name}`,
  name,
  driver: 'bridge',
  project: name.replace(/_default$/, ''),
  subnets: [],
  ...over
})

const noExternals: ExternalDeclarations = { names: new Set(), unresolvedProjects: [] }

describe('parseNetworkInspect', () => {
  it('reads id, name, driver, compose project and IPv4 subnets; drops IPv6 and junk', () => {
    const stdout = JSON.stringify([
      {
        Id: 'n1',
        Name: 'proj-13_default',
        Driver: 'bridge',
        Labels: { [COMPOSE_PROJECT_LABEL]: 'proj-13', other: 'x' },
        IPAM: {
          Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }, { Subnet: 'fd00:1::/64' }]
        }
      },
      { Id: 'n2', Name: 'bridge', Driver: 'bridge', Labels: null, IPAM: { Config: null } },
      { Name: 'no-id' },
      'junk'
    ])
    expect(parseNetworkInspect(stdout)).toEqual([
      {
        id: 'n1',
        name: 'proj-13_default',
        driver: 'bridge',
        project: 'proj-13',
        subnets: ['172.20.0.0/16']
      },
      { id: 'n2', name: 'bridge', driver: 'bridge', project: null, subnets: [] }
    ])
    expect(parseNetworkInspect('not json')).toEqual([])
    expect(parseNetworkInspect('{}')).toEqual([])
  })
})

describe('externalNetworkNamesOf', () => {
  it('returns the resolved name of every external network, in either spelling', () => {
    const cfg = JSON.stringify({
      name: 'web',
      networks: {
        default: { name: 'web_default' },
        shared: { name: 'proj-13_default', external: true },
        other: { external: { name: 'legacy' } },
        bare: { external: true }
      }
    })
    expect(externalNetworkNamesOf(cfg)?.sort()).toEqual(['bare', 'legacy', 'proj-13_default'])
  })

  it('returns an empty list when the project declares no external network', () => {
    expect(externalNetworkNamesOf(JSON.stringify({ name: 'web' }))).toEqual([])
    expect(externalNetworkNamesOf(JSON.stringify({ networks: { default: {} } }))).toEqual([])
  })

  it('returns null when it cannot be sure of a name', () => {
    expect(externalNetworkNamesOf('not json')).toBeNull()
    expect(externalNetworkNamesOf('[]')).toBeNull()
    expect(
      externalNetworkNamesOf(
        JSON.stringify({ networks: { a: { name: '${NET}', external: true } } })
      )
    ).toBeNull()
  })
})

describe('planEmptyComposeNetworks', () => {
  it('releases a compose network with no container attached', () => {
    const plan = planEmptyComposeNetworks({
      networks: [net('proj-13_default')],
      containers: [],
      externals: noExternals
    })
    expect(plan.garbage.map((n) => n.name)).toEqual(['proj-13_default'])
    expect(plan.held).toEqual([])
  })

  it('keeps a network that only a STOPPED container is attached to', () => {
    const plan = planEmptyComposeNetworks({
      networks: [net('proj-14_default')],
      containers: [
        composeContainer('proj-14', null, {
          state: 'exited',
          networks: [{ name: 'proj-14_default', id: 'id-proj-14_default' }]
        })
      ],
      externals: noExternals
    })
    expect(plan.garbage).toEqual([])
    expect(plan.held).toEqual([])
  })

  it('matches an attachment by network id when the name differs', () => {
    const plan = planEmptyComposeNetworks({
      networks: [net('proj-15_default')],
      containers: [container({ networks: [{ name: 'renamed', id: 'id-proj-15_default' }] })],
      externals: noExternals
    })
    expect(plan.garbage).toEqual([])
  })

  it('keeps a network attached by a container of a DIFFERENT project', () => {
    const plan = planEmptyComposeNetworks({
      networks: [net('proj-16_default')],
      containers: [
        composeContainer('other', null, {
          networks: [{ name: 'proj-16_default', id: 'id-proj-16_default' }]
        })
      ],
      externals: noExternals
    })
    expect(plan.garbage).toEqual([])
  })

  it('ignores a network that carries no compose project label', () => {
    const plan = planEmptyComposeNetworks({
      networks: [net('hand-made', { project: null })],
      containers: [],
      externals: noExternals
    })
    expect(plan).toEqual({ garbage: [], held: [] })
  })

  it('never releases docker built-ins, even if a label were present', () => {
    const plan = planEmptyComposeNetworks({
      networks: [
        net('bridge', { project: 'x' }),
        net('host', { driver: 'host', project: 'x' }),
        net('none', { driver: 'null', project: 'x' })
      ],
      containers: [],
      externals: noExternals
    })
    expect(plan).toEqual({ garbage: [], held: [] })
  })

  it('holds a network some stack declares external', () => {
    const plan = planEmptyComposeNetworks({
      networks: [net('proj-13_default'), net('proj-14_default')],
      containers: [],
      externals: { names: new Set(['proj-13_default']), unresolvedProjects: [] }
    })
    expect(plan.garbage.map((n) => n.name)).toEqual(['proj-14_default'])
    expect(plan.held.map((h) => [h.network.name, h.reason])).toEqual([
      ['proj-13_default', 'external']
    ])
  })

  it('holds EVERY would-be-garbage network while a project cannot be resolved', () => {
    const plan = planEmptyComposeNetworks({
      networks: [net('proj-13_default'), net('proj-14_default')],
      containers: [],
      externals: { names: new Set(), unresolvedProjects: ['broken'] }
    })
    expect(plan.garbage).toEqual([])
    expect(plan.held.map((h) => h.reason)).toEqual(['externals-unresolved', 'externals-unresolved'])
  })

  it('does not release a network that still has a container just because externals are unresolved', () => {
    const plan = planEmptyComposeNetworks({
      networks: [net('proj-13_default')],
      containers: [
        composeContainer('proj-13', null, { networks: [{ name: 'proj-13_default', id: null }] })
      ],
      externals: { names: new Set(), unresolvedProjects: ['broken'] }
    })
    expect(plan).toEqual({ garbage: [], held: [] })
  })

  it('sorts garbage and held by network name', () => {
    const plan = planEmptyComposeNetworks({
      networks: [net('b_default'), net('a_default'), net('c_default')],
      containers: [],
      externals: { names: new Set(['c_default', 'b_default']), unresolvedProjects: [] }
    })
    expect(plan.garbage.map((n) => n.name)).toEqual(['a_default'])
    expect(plan.held.map((h) => h.network.name)).toEqual(['b_default', 'c_default'])
  })
})
