// Fixture for scripts/verify/isolation-tenant.test.mjs: the same two-tenant
// store, scoped correctly. It is the positive control of the suite test: a
// passing run MUST write the evidence file, or the leaky run proves nothing.
export function createStore() {
  const rows = []
  return {
    put(tenant, value) {
      rows.push({ tenant, value })
    },
    list(tenant) {
      return rows.filter((r) => r.tenant === tenant).map((r) => r.value)
    },
  }
}
