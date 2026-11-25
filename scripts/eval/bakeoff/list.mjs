/**
 * `list [--split]`: the dev problems with their kind and language; for the holdout, the count and
 * nothing that could name a problem. "Holdout on the terminal" in
 * `docs/specs/2026-11-07-bakeoff-harness/spec.md` is the contract.
 */
import { join } from 'node:path'
import { loadCorpus } from './corpus.mjs'

const DEV_CORPUS = 'scripts/eval/bakeoff/corpus/dev'

/**
 * @param {{ split?: string }} args
 * @param {{ roots: object, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream }} ctx
 * @returns {number}
 */
export function listCommand(args, ctx) {
  const { roots, stdout, stderr } = ctx
  if (args.split === 'holdout') {
    const { problems, errors } = loadCorpus(roots.holdout, { split: 'holdout' })
    stdout.write(`${problems.length} holdout problems\n`)
    if (errors.length > 0) stderr.write(`${errors.length} holdout problem errors\n`)
    return 0
  }
  const { problems, errors } = loadCorpus(join(roots.repo, DEV_CORPUS), { split: 'dev' })
  for (const problem of problems) {
    stdout.write(`${problem.id}\t${problem.kind}\t${problem.language}\n`)
  }
  for (const error of errors) stderr.write(`${error.code}: ${error.message} [${error.file}]\n`)
  return 0
}
