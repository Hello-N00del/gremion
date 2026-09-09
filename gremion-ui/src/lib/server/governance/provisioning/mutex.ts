// In-process per-key async mutex (Pillar-1 P0.3a). Serializes inline-create provisioning against
// the cron worker for the same org_unit so they never double-drive a freshly-enqueued unit and
// double-create an external resource. Single-replica only — multi-replica forward-fit is a DB
// advisory-lock / FOR UPDATE SKIP LOCKED claim (deferred).

const chains = new Map<string, Promise<unknown>>()

export async function withUnitLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => {
    release = r
  })
  chains.set(key, prev.then(() => next))
  await prev.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (chains.get(key) === next) chains.delete(key)
  }
}
