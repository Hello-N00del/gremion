// Text for an error value the NATS client hands the live harness's status
// loop. Never throws (a circular object or a BigInt makes JSON.stringify
// throw, which would end the floating loop in harness.ts open() silently).
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    const j = JSON.stringify(e)
    if (j !== undefined) return j
  } catch {
    // fall through to String()
  }
  return String(e)
}
