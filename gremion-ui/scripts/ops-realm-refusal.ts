// Why `gremion-tenant init` refuses an existing ops realm, as one pure function.
//
// The realm carries one fingerprint, sha256(template text + "\n" + panel origin), so a
// mismatch has two causes with two different remedies, and the stored value alone cannot
// tell them apart:
//   - ORIGIN: the realm was made for another panel origin. The origin is bound to the
//     realm's redirect URIs, web origin and fingerprint and cannot change in place; the
//     install needs a new ops realm.
//   - TEMPLATE: the realm was made by an earlier release's template (same origin). It is
//     brought up to the current template by hand and re-stamped (upgrade runbook, step 8a).
// The realm's own control-panel client says which origin it was made for (its one redirect
// URI is `<origin>/*`): the fingerprint of the CURRENT template with THAT origin equals the
// stored one exactly when only the origin differs. gremion-tenant's kcadm path
// (init_realm_only_kcadm) does the same in bash; test/host/tenant.bats holds that side.
import { createHash } from 'node:crypto'

export type OpsRealmRefusalKind = 'origin' | 'template' | 'unknown'

export interface OpsRealmRefusal {
  readonly kind: OpsRealmRefusalKind
  readonly message: string
}

export function opsRealmFingerprint(templateText: string, origin: string): string {
  return createHash('sha256').update(templateText).update('\n').update(origin).digest('hex')
}

/** The origin a realm was made for: its control-panel client's one redirect URI minus the `/*`. */
export function storedPanelOrigin(redirectUris: readonly string[] | undefined): string {
  const first = redirectUris?.[0] ?? ''
  return first.endsWith('/*') ? first.slice(0, -2) : ''
}

export function opsRealmRefusal(args: {
  realm: string
  templateText: string
  origin: string
  storedFingerprint: string | undefined
  storedRedirectUris: readonly string[] | undefined
}): OpsRealmRefusal {
  const { realm, templateText, origin, storedFingerprint } = args
  const stored = storedPanelOrigin(args.storedRedirectUris)
  if (stored !== '' && stored !== origin && storedFingerprint === opsRealmFingerprint(templateText, stored)) {
    return {
      kind: 'origin',
      message: `realm ${realm} differs from realm-export.ops.json for panel origin ${origin}: it was made for the panel origin ${stored}, and an origin cannot change in place (the realm's redirect URIs, web origin and fingerprint are bound to it); this install needs a new ops realm for ${origin}, or its origin put back to ${stored}. The template is not the difference, so step 8a of docs/ops/runbook/upgrade.md does not apply`,
    }
  }
  if (stored === origin) {
    return {
      kind: 'template',
      message: `realm ${realm} differs from realm-export.ops.json for panel origin ${origin}: the origin is the one it was made for, so its template is the difference (fingerprint ${storedFingerprint ?? 'absent'}). A realm made by an earlier release's template is brought up to this one with kcadm, then re-stamped: docs/ops/runbook/upgrade.md, step 8a (read its precondition first)`,
    }
  }
  return {
    kind: 'unknown',
    message: `realm ${realm} differs from realm-export.ops.json for panel origin ${origin} (fingerprint ${storedFingerprint ?? 'absent'}), and the realm's control-panel client does not say which origin it was made for, so the cause is not known: either the origin changed (it cannot change in place; the install needs a new ops realm) or the realm was made by an earlier template (docs/ops/runbook/upgrade.md, step 8a, whose precondition tells which)`,
  }
}
