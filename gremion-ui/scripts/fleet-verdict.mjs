// gremion-ui/scripts/fleet-verdict.mjs
//
// TASK-042 R28: the exit code and report of `pnpm migrate`
// (run-migrations-verified.mjs) over a runFleetMigrations() outcome map.
//
// Since the zero-tenant boot (PRD-PLAT-012, TRD-075) the kernel registers no
// tenant, so on an empty registry `pnpm migrate` migrates the control plane
// and ZERO data planes. That is a legitimate state (a fresh host before its
// first customer; gremion-deploy runs the migrate one-shot there), so it is
// exit 0 by default, but the report says so explicitly instead of the old
// "all tenants migrated". A caller that needs a migrated data plane opts in
// with `--require-tenant` (or MIGRATE_REQUIRE_TENANT=1) and then fails there.
// Pure: no I/O, no process access, unit-tested in tests/unit/fleet-verdict.test.ts.

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function requireTenantFrom(argv, env) {
  return argv.includes('--require-tenant') || env.MIGRATE_REQUIRE_TENANT === '1'
}

/**
 * @param {Map<string, { ok: boolean, error?: string, cause?: unknown }>} outcomes
 * @param {{ requireTenant?: boolean, tag?: string }} [opts]
 * @returns {{ code: 0 | 1, errors: unknown[][], info: string[] }}
 *   errors: console.error argument lists; info: console.info lines.
 */
export function fleetVerdict(outcomes, { requireTenant = false, tag = '[run-migrations-verified]' } = {}) {
  const failed = [...outcomes.entries()].filter(([, o]) => !o.ok)
  if (failed.length > 0) {
    return { code: 1, errors: failed.map(([id, o]) => [`${tag} tenant ${id} FAILED: ${o.error ?? ''}`, o.cause ?? '']), info: [] }
  }
  if (outcomes.size === 0) {
    if (requireTenant) {
      return {
        code: 1,
        errors: [[
          `${tag} FAILED: the registry has ZERO active tenants, so no data plane was migrated, and this caller requires one (--require-tenant). ` +
            'Provision a tenant first; the integration harness runs `pnpm migrate:test-fixture` instead.',
        ]],
        info: [],
      }
    }
    return {
      code: 0,
      errors: [],
      info: [
        `${tag} control plane migrated + verified; ZERO tenants in the registry, so NO data plane was migrated ` +
          '(zero-tenant boot, TASK-042). Pass --require-tenant to fail here instead.',
      ],
    }
  }
  return { code: 0, errors: [], info: [`${tag} control plane + ${outcomes.size} tenant data plane(s) migrated + verified`] }
}
