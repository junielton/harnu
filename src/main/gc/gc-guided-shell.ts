// The env-bound half of the guided actions (ADR-0001: wired here, decided in gc-guided.ts). Reads the
// running Harnu sessions, parks one, asks git and Docker, and finds who owns a folder. The imports are
// dynamic so loading this file for its types never loads electron.

import type { GcShellDeps } from './gc-shell'
import type { GuidedDeps, GuidedSession } from './gc-guided'
import { createGitGuided, sessionCountsHere, sessionStateOf, userNameOfUid } from './gc-guided'

export async function defaultGuidedDeps(shellDeps: GcShellDeps): Promise<GuidedDeps> {
  const [fsp, os, pty, hookBridge, fleet, hibernation, containersCore, shell, containersShell] =
    await Promise.all([
      import('node:fs/promises'),
      import('node:os'),
      import('../pty'),
      import('../hook-bridge'),
      import('../fleet-model'),
      import('../hibernation'),
      import('../containers/containers-core'),
      import('./gc-shell'),
      import('../containers/containers-shell')
    ])

  const real = async (p: string): Promise<string> => {
    try {
      return await fsp.realpath(p)
    } catch {
      return p
    }
  }

  /**
   * Running Harnu sessions in `path` or under it: a live PTY Harnu spawned, and nothing else. A `claude`
   * started in a terminal outside Harnu has no PTY here, so it can never be closed from here. A session
   * working or waiting for the operator is busy, and so is the owner of a mission with a live child.
   */
  const sessionsIn = async (
    path: string,
    nestedWorktrees: readonly string[]
  ): Promise<GuidedSession[]> => {
    const root = await real(path)
    const nested = await Promise.all(nestedWorktrees.map(real))
    const running = pty.liveSessionKeys()
    const states = hookBridge.getTaskStates()
    const folders = await fleet.getFleetFolders()
    const found: Array<{ key: string; cwd: string }> = []
    for (const folder of folders) {
      if (!folder.sessions.some((s) => running.has(s.sessionId))) continue
      const where = await real(folder.path)
      if (!sessionCountsHere(where, root, nested, containersCore.isInside)) continue
      for (const s of folder.sessions) {
        if (running.has(s.sessionId)) found.push({ key: s.sessionId, cwd: folder.path })
      }
    }
    const owners = hibernation.missionOwnersWithLiveChildren(
      found.map((f) => ({ sessionKey: f.key, cwd: f.cwd }))
    )
    return found.map((f): GuidedSession => ({
      key: f.key,
      state: sessionStateOf(states.get(f.key), owners.has(f.key)),
      origin: pty.spawnOriginForSession(f.key) === 'agent' ? 'agent' : 'operator'
    }))
  }

  const ownerOf = async (path: string): Promise<string | null> => {
    const st = await fsp.stat(path)
    if (process.platform === 'win32') return null
    if (os.userInfo().uid === st.uid) return os.userInfo().username
    // Another user: their name from /etc/passwd, or the number when it cannot be read.
    const passwd = await fsp.readFile('/etc/passwd', 'utf8').catch(() => null)
    return userNameOfUid(st.uid, passwd)
  }

  return {
    ...createGitGuided((repo, args) => shellDeps.executor.git(repo, args)),
    sessionsIn,
    park: (key) => void pty.parkSessionByKey(key),
    folderHasSession: async (folder) => {
      const where = await real(folder)
      const running = pty.liveSessionKeys()
      const parked = hibernation.hibernatedKeys()
      let state: 'none' | 'live' | 'parked' = 'none'
      for (const f of await fleet.getFleetFolders()) {
        if (!containersCore.isInside(await real(f.path), where)) continue
        for (const s of f.sessions) {
          if (running.has(s.sessionId)) return 'live'
          if (parked.has(s.sessionId)) state = 'parked'
        }
      }
      return state
    },
    listStacks: () => shellDeps.listStacks(),
    realPaths: (paths) => shell.resolveRealPaths(paths, (p) => fsp.realpath(p)),
    docker: containersShell.dockerActions,
    walkForeign: (root) => shell.findForeignCheckouts(root),
    ownerOf,
    currentUser: () => os.userInfo().username,
    platform: process.platform
  }
}
