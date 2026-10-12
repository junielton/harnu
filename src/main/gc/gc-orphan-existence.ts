// "Is this folder there?" for the orphan-transcript listing. It answers only that. A missing entry
// is NOT proof the folder is gone (a drive that is not mounted right now has no folder either), so
// "gone" is decided apart, by positive proof (gc-orphan-proof.ts); this only separates a folder that
// exists, one that is missing, and one Harnu could not even look at.

import { promises as fs } from 'node:fs'

export type Existence = 'exists' | 'missing' | 'unknown'

export async function fsPathExistence(p: string): Promise<Existence> {
  try {
    // lstat: a dangling symlink is still there (its target is what is missing).
    await fs.lstat(p)
    return 'exists'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown'
  }
}
