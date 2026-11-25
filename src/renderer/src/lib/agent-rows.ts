// Pure label / grouping rules for the nested subagent rows in the sidebar
// (design.md §6 "Agent row (sidebar)"). No Vue, no store — unit-tested.

/** Max characters of a task-derived label (including the trailing ellipsis). */
export const TASK_LABEL_MAX = 60

/**
 * What the row says the subagent did: the meta.json `description`, else a
 * one-line truncation of the task, else the caller's generic label.
 */
export function agentRowLabel(a: { description?: string; task?: string }, generic: string): string {
  const description = oneLine(a.description)
  if (description) return description
  const task = oneLine(a.task)
  if (!task) return generic
  return task.length > TASK_LABEL_MAX ? `${task.slice(0, TASK_LABEL_MAX - 1).trimEnd()}…` : task
}

/** The dimmed type chip: a known agent type, never the word "subagent". */
export function agentTypeChip(a: { agentType?: string }): string {
  const type = (a.agentType ?? '').trim()
  return type.toLowerCase() === 'subagent' ? '' : type
}

/** Running agents stay listed; done ones fold. Input order is preserved. */
export function splitAgentsByStatus<T extends { status: 'running' | 'done' }>(
  agents: readonly T[]
): { running: T[]; done: T[] } {
  const running: T[] = []
  const done: T[] = []
  for (const a of agents) (a.status === 'running' ? running : done).push(a)
  return { running, done }
}

export type AgentRowPlan<T> =
  { kind: 'agent'; agent: T } | { kind: 'fold'; count: number; expanded: boolean }

/**
 * The rows the sidebar renders under a session: running agents first (always
 * listed), then ONE "N done" fold row, then — only when it is expanded — the
 * done agents. No fold row when nothing is done.
 */
export function agentRowPlan<T extends { status: 'running' | 'done' }>(
  agents: readonly T[],
  doneExpanded: boolean
): AgentRowPlan<T>[] {
  const { running, done } = splitAgentsByStatus(agents)
  const rows: AgentRowPlan<T>[] = running.map((agent) => ({ kind: 'agent', agent }))
  if (done.length === 0) return rows
  rows.push({ kind: 'fold', count: done.length, expanded: doneExpanded })
  if (doneExpanded) for (const agent of done) rows.push({ kind: 'agent', agent })
  return rows
}

function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}
