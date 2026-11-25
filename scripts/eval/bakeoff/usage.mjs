/**
 * Token usage and sub-agent counts, read from what a session left on disk.
 *
 * A transcript holds one line per content block, so one assistant message spans several
 * lines that repeat its usage: every message counts once, by `message.id`. A line that
 * is not JSON (the tail of a killed session) is skipped.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SUB_AGENT_TOOLS = new Set(['Task', 'Agent'])

function jsonLines(path) {
  const records = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      /* a torn line */
    }
  }
  return records
}

/** The session transcripts directly in `dir` and the sub-agent transcripts below it. */
function transcriptFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => join(e.parentPath, e.name))
    .filter((path) => {
      const rel = relative(dir, path)
      return !rel.includes(sep) || rel.includes(`${sep}subagents${sep}`)
    })
    .sort()
}

/**
 * Sum one role directory (`transcripts/<role>/`), sub-agent transcripts included.
 *
 * @param {string} dir
 * @returns {{ input: number, cacheWrite: number, cacheRead: number, output: number, total: number }}
 */
export function sumUsage(dir) {
  const sum = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 }
  const seen = new Set()
  for (const file of transcriptFiles(dir)) {
    for (const record of jsonLines(file)) {
      if (record.type !== 'assistant' || !record.message?.usage) continue
      const id = record.message.id
      if (id !== undefined) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      const u = record.message.usage
      sum.input += u.input_tokens ?? 0
      sum.cacheWrite += u.cache_creation_input_tokens ?? 0
      sum.cacheRead += u.cache_read_input_tokens ?? 0
      sum.output += u.output_tokens ?? 0
    }
  }
  sum.total = sum.input + sum.cacheWrite + sum.cacheRead + sum.output
  return sum
}

/**
 * Sub-agents spawned: the `Task` and `Agent` tool_use blocks in stream-json output.
 *
 * @param {string[]} streamPaths
 * @returns {number}
 */
export function countSubAgents(streamPaths) {
  let count = 0
  for (const path of streamPaths) {
    for (const event of jsonLines(path)) {
      if (event.type !== 'assistant') continue
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use' && SUB_AGENT_TOOLS.has(block.name)) count += 1
      }
    }
  }
  return count
}
