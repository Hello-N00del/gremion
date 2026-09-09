// src/lib/server/tenant/provisioner/wizard-gate.ts
// P2.1c (T10) — D-WIZARD gate (PURE). The setup wizard stores a deployment-mode
// choice additively in the DEFAULT tenant's config as
// `deployment: { mode: 'single' | 'multi' }` (the wizard UI + config-schema
// change is T12). The provisioner REFUSES to provision a second tenant while
// the default config says `single` (the default), with a clear operator message
// naming the toggle. Tenant creation stays an operator command — never
// self-serve.
//
// This module is a CONSUMER of the deployment.mode field; it reads it
// defensively from the already-parsed config object so it works whether or not
// T12 has been applied (absent field => 'single' => refuse, fail-closed).

export type DeploymentMode = 'single' | 'multi'

/** Defensive read: returns the configured deployment mode, defaulting to the
 *  fail-closed `'single'` for any absent/unrecognized value. */
export function deploymentModeOf(config: unknown): DeploymentMode {
  const mode = (config as { deployment?: { mode?: unknown } } | null)?.deployment?.mode
  return mode === 'multi' ? 'multi' : 'single'
}

/** D-WIZARD gate: throw unless the default config opts into multi-tenant mode. */
export function assertMultiTenantEnabled(defaultConfig: unknown): void {
  if (deploymentModeOf(defaultConfig) !== 'multi') {
    throw new Error(
      'provision refused: this deployment is in single-tenant mode. ' +
        'Set the default tenant config `deployment.mode` to "multi" (Setup -> deployment mode) before provisioning a second tenant.',
    )
  }
}
