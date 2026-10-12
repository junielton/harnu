// The env-bound half of the guided actions (ADR-0001: wired here, decided in gc-guided.ts). Reads the
// running Harnu sessions, parks one, asks git and Docker, and finds who owns a folder. The imports are
// dynamic so loading this file for its types never loads electron.

import type { GcShellDeps } from './gc-shell'
import type { GuidedDeps, GuidedSession } from './gc-guided'
import { createGitGuided } from './gc-guided'

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
  const sessionsIn = async (path: string): Promise<GuidedSession[]> => {
    const root = await real(path)
    const running = pty.liveSessionKeys()
    const states = hookBridge.getTaskStates()
    const folders = await fleet.getFleetFolders()
    const found: Array<{ key: string; cwd: string }> = []
    for (const folder of folders) {
      if (!folder.sessions.some((s) => running.has(s.sessionId))) continue
      const where = await real(folder.path)
      if (!containersCore.isInside(where, root)) continue
      for (const s of folder.sessions) {
        if (running.has(s.sessionId)) found.push({ key: s.sessionId, cwd: folder.path })
      }
    }
    const owners = hibernation.missionOwnersWithLiveChildren(
      found.map((f) => ({ sessionKey: f.key, cwd: f.cwd }))
    )
    return found.map((f) => {
      const state = states.get(f.key)
      const busy = state === 'working' || state === 'needs-input'
      return {
        key: f.key,
        state: busy ? state : owners.has(f.key) ? 'working' : 'idle'
      } as GuidedSession
    })
  }

  const ownerOf = async (path: string): Promise<string | null> => {
    const st = await fsp.stat(path)
    if (process.platform === 'win32') return null
    try {
      return os.userInfo().uid === st.uid ? os.userInfo().username : String(st.uid)
    } catch {
      return String(st.uid)
    }
  }

  return {
    ...createGitGuided((repo, args) => shellDeps.executor.git(repo, args)),
    sessionsIn,
    park: (key) => void pty.parkSessionByKey(key),
    listStacks: () => shellDeps.listStacks(),
    realPaths: (paths) => shell.resolveRealPaths(paths, (p) => fsp.realpath(p)),
    docker: containersShell.dockerActions,
    walkForeign: (root) => shell.findForeignCheckouts(root),
    ownerOf,
    currentUser: () => os.userInfo().username,
    platform: process.platform
  }
}
