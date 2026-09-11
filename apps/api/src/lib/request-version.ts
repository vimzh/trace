/** Parses the model version carried by an If-Match precondition. */
export function parseExpectedModelVersion(
  value: string | undefined,
): number | null | undefined {
  if (value === undefined) return undefined
  const match = /^(?:"(\d+)"|(\d+))$/.exec(value.trim())
  if (!match) return null
  const version = Number(match[1] ?? match[2])
  return Number.isSafeInteger(version) ? version : null
}

/** Parses the optional one-based version query used for historical reads. */
export function parseModelVersionQuery(
  value: string | undefined,
): number | null | undefined {
  if (value === undefined) return undefined
  if (!/^[1-9]\d*$/.test(value)) return null
  const version = Number(value)
  return Number.isSafeInteger(version) ? version : null
}
