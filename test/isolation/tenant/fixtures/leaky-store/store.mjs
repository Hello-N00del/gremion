// Fixture for scripts/verify/isolation-tenant.test.mjs: a two-tenant store
// that LEAKS. list() ignores the tenant it is asked for, so tenant B's rows
// are readable as tenant A. The isolation case under cases/ must therefore
// fail, and the suite part must fail with it (and write no evidence file).
export function createStore() {
  const rows = []
  return {
    put(tenant, value) {
      rows.push({ tenant, value })
    },
    list(_tenant) {
      return rows.map((r) => r.value)
    },
  }
}
