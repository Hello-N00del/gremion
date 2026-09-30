// src/lib/server/tenant/provisioner/pipeline.ts
// The provisioner's shared Keycloak constants.
//
// TASK-043 retired the P2.1c provisionTenant pipeline that lived here. A
// customer is now created by `gremion-tenant create`: @gremion/provisioning
// holds the order and the ledger (plt.provisioning_step, EXECUTION_ORDER), and
// customer-adapters.ts holds the $lib adapters. What the old pipeline did and
// where it went:
//   - registry INSERT-FIRST as `provisioning`, the primary tenant_domain row,
//     the resource ledger rows          -> customer-adapters control.registerProvisioning
//   - CREATE DATABASE t_<slug> + a LOGIN owner role
//                                        -> ensureKernelDatabase: t_<hex32>__kernel,
//                                           three roles, pgbouncer.get_auth kept
//   - realm create + step-up + the gremion-admin SA grant
//                                        -> customer-adapters realm.ensureRealm
//   - the platform@ SMTP delta re-stamped on EVERY pass
//                                        -> GONE: a customer realm is created with no
//                                           sender, the host stamps its OWN kc-<token>@
//                                           principal (gremion-vendor-mail realm-smtp
//                                           --tenant), and reconcile's smtp-server
//                                           check detects drift (repair: host)
//   - the final flip to `active`         -> createPhaseB, after all eight steps are done

/** The KC-admin service-account client whose SA must hold realm-management roles. */
export const ADMIN_CLIENT_ID = 'gremion-admin'

/** (A) The realm-management client role(s) the gremion-admin SA must hold --
 *  exactly what the live `assign_realm_admin_to_sa` assigns
 *  (configure-keycloak-clients.sh). `realm-admin` is the composite that carries
 *  manage-users / manage-groups / view-realm, which governance sync, newsletter
 *  group resolution and #164 step-up freshness all need. Imports do NOT carry SA
 *  role mappings reliably in KC 26, so the provisioner grants them post-create. */
export const GREMION_ADMIN_SA_REALM_ROLES = ['realm-admin'] as const
