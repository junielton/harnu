/**
 * Mission v3 S2 (§3.8) — map over `items` with at most `limit` calls of `fn`
 * in flight, results in INPUT order (not completion order). `mission:list`
 * derives its missions through this instead of one after another: each derive
 * waits mostly on `gh`, so four at a time cut a pass from the sum of the
 * derives to roughly the slowest wave.
 *
 * The first rejection rejects the whole map, and no job starts after it (the
 * ones already in flight run to their end, unobserved). A `limit` below 1 is
 * treated as 1.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i])
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  const width = Math.min(Math.max(1, Math.floor(limit) || 1), items.length)
  await Promise.all(Array.from({ length: width }, worker))
  return out
}
