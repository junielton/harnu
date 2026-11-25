/**
 * BUG-298 (AC-4): W-12 compares the operator's real `.harnu/walks` and `.harnu/missions-v4` before and after a run.
 * Those folders are written by every other session of the operator while the smoke test runs (a live mission file,
 * a walk someone is walking), so "byte-identical" failed for reasons that had nothing to do with the instance.
 *
 * The instance runs on a throwaway HOME and throwaway repos under /tmp/hv-walk-<id>, and Harnu records the folder
 * a record belongs to. So anything the instance wrote into the real `.harnu/` carries that run's directory or its
 * id. A file that changed WITHOUT mentioning this run was written by somebody else; one that mentions it, or that
 * vanished (nobody else removes these), is a real leak.
 *
 * @param {Record<string, string>} before path -> sha256 before the run
 * @param {Record<string, string>} after path -> sha256 after the run
 * @param {(file: string) => string} readText current text of a file
 * @param {string[]} markers strings only this run's instance can have written (its run directory and id)
 * @returns {{ leaked: string[], foreign: string[] }} files this run wrote or removed, and files others changed
 */
export function attributeChanges(before, after, readText, markers) {
  const leaked = []
  const foreign = []
  for (const f of Object.keys(before)) if (!(f in after)) leaked.push(f)
  for (const f of Object.keys(after)) {
    if (before[f] === after[f]) continue
    let text = ''
    try {
      text = readText(f)
    } catch {
      /* unreadable: no marker can be found, so it is somebody else's */
    }
    ;(markers.some((m) => text.includes(m)) ? leaked : foreign).push(f)
  }
  return { leaked, foreign }
}
