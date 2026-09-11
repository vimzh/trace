/** Matches only the partial unique index that serializes tactile jobs. */
export function isRunningTactileJobConflict(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 3; depth++) {
    if (typeof current !== 'object' || current === null) return false
    const record = current as Record<string, unknown>
    if (
      (record.code === '23505' || record.errno === '23505') &&
      record.constraint === 'tactile_designs_one_running_per_project'
    ) {
      return true
    }
    current = record.cause
  }
  return false
}
