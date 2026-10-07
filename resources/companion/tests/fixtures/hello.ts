/**
 * Golden fixtures for `hello` (contract §5.1). Shared by the host replay in
 * `tests/companion/contract.test.ts` and, from P1W2 on, by the mod harness. Every id below is a
 * well-formed placeholder: no real token ever lands in a fixture (SEC-8).
 */
import type { Conn, HelloRequest, HelloResponse, SpawnToken } from '../../hooks/contract'
import { DEFAULT_CONFIG } from '../../hooks/contract'

export const FIXTURE_SID = '11111111-1111-4111-8111-111111111111'
export const FIXTURE_SPAWN: SpawnToken = 'sp_00000000-0000-4000-8000-000000000001'
export const FIXTURE_CONN: Conn = 'c_00000000000000000000000000000001'

/** The first hello of a Harnu-spawned interactive process. */
export const helloSpawnRequest: HelloRequest = {
  protoMin: 1,
  protoMax: 1,
  sid: FIXTURE_SID,
  spawn: FIXTURE_SPAWN,
  cli: { version: '2.1.287' },
  mod: { version: '0.1.0' },
  surface: 'terminal',
  isInteractive: true,
  cwd: '/tmp/example-project',
  declared: ['sense.identity'],
  sentAt: 1_790_000_000_000
}

/** A hot reload: the mod found its `conn` in `$.state` and re-hellos. */
export const helloResumeRequest: HelloRequest = {
  protoMin: 1,
  protoMax: 1,
  sid: FIXTURE_SID,
  resume: { conn: FIXTURE_CONN },
  cli: { version: '2.1.287' },
  mod: { version: '0.1.0' },
  surface: 'terminal',
  isInteractive: true,
  cwd: '/tmp/example-project',
  declared: ['sense.identity'],
  sentAt: 1_790_000_005_000
}

/** `claude -p`: no surface, not interactive. */
export const helloHeadlessRequest: HelloRequest = {
  ...helloSpawnRequest,
  surface: null,
  isInteractive: false
}

/** What the host answers when no feature is enabled (P1W1: always). */
export const helloResponseOk: HelloResponse = {
  ok: true,
  proto: 1,
  conn: FIXTURE_CONN,
  bootId: 'b_00000000-0000-4000-8000-0000000000b1',
  sessionKey: null,
  profile: 'interactive',
  enable: [],
  config: { ...DEFAULT_CONFIG }
}

/** A hello answered for a session whose features are on. */
export const helloResponseEnabled: HelloResponse = {
  ...helloResponseOk,
  sessionKey: 'session-key-fixture',
  enable: ['sense.identity']
}

/** A hello answered for a headless session. */
export const helloResponseHeadless: HelloResponse = {
  ...helloResponseOk,
  profile: 'headless'
}
