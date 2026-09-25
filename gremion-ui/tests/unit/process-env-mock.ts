// TASK-032 (TRD-410 [D R20-D5]): shared test helper for tests that used to
// mock `$env/dynamic/private`/`$env/dynamic/public`. Production code now
// reads `process.env` directly (kit 3's dynamic-env modules expose only vars
// declared via `defineEnvVars`, which nothing here uses — see the migration
// commit for the full rationale), so mocking the removed virtual module no
// longer has any effect: the mocked value never reaches the code under test.
//
// `envMock` is a Proxy over the REAL `process.env`, so `envMock.KEY = 'x'`
// still sets the value the migrated code actually reads, but it tracks only
// the keys THIS proxy has touched — `Object.keys(envMock)` and `delete
// envMock.KEY` therefore only ever see/remove that tracked subset, never the
// process's real ambient env (PATH, HOME, CI, …). This preserves every
// existing test's `envMock.FOO = ...` / `delete envMock.FOO` / `for (const k
// of Object.keys(envMock)) delete envMock[k]` idiom byte-for-byte; only the
// now-dead `vi.mock('$env/dynamic/private', () => ({ env: envMock }))` line
// (and the `vi.hoisted`/plain-object `envMock` declaration it mocked in with)
// needs to be removed at each call site.
const touched = new Set<string>()

export const envMock = new Proxy(process.env as Record<string, string | undefined>, {
  set(target, key, value) {
    touched.add(String(key))
    target[String(key)] = value as string | undefined
    return true
  },
  deleteProperty(target, key) {
    touched.delete(String(key))
    delete target[String(key)]
    return true
  },
  ownKeys() {
    return [...touched]
  },
  getOwnPropertyDescriptor(target, key) {
    if (!touched.has(String(key))) return undefined
    return { enumerable: true, configurable: true, value: target[String(key)] }
  },
  get(target, key) {
    return target[String(key)]
  },
})

/** Clears every key this proxy has ever set, restoring nothing it didn't touch. */
export function resetEnvMock(): void {
  for (const key of touched) delete process.env[key]
  touched.clear()
}
