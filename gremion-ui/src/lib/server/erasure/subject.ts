// R33f HIGH — binding an erasure subject to the current tenant.
//
// Nextcloud (files, votes) is ONE instance for every tenant and its account ids are
// the Keycloak ids of every realm, so a plausible id from another tenant must never
// reach those hooks. The subject is therefore resolved before the run:
//
//   1. a user of THIS tenant's Keycloak realm -> verified, with username and e-mail;
//   2. gone from the realm but the tenant's own database holds data of it (a
//      membership, a role history, queued remove-ops, or an earlier erasure report
//      of this tenant) -> verified, identity unresolvable (username/email null);
//   3. neither -> unknown: the run is refused.
//
// Any other realm error is not an answer and propagates (fail closed).
import type { ErasureSubject } from '@gremion/ports/erasure'

/** The run was refused: the tenant knows nothing of this id. Carries no identifier. */
export class ErasureSubjectUnknownError extends Error {
  constructor() {
    super('the subject is unknown in this tenant')
    this.name = 'ErasureSubjectUnknownError'
  }
}

export interface SubjectResolverDeps {
  /** The realm user; throws Error('User not found') for a 404 (KeycloakAdminClient.getUser). */
  getUser(id: string): Promise<{ username?: string | null; email?: string | null }>
  /** True when the tenant's own database holds data of this id. */
  hasTenantEvidence(id: string): Promise<boolean>
}

export function createSubjectResolver(deps: SubjectResolverDeps): (subjectId: string) => Promise<ErasureSubject | null> {
  return async (subjectId) => {
    try {
      const user = await deps.getUser(subjectId)
      return { id: subjectId, username: user.username || null, email: user.email ?? '' }
    } catch (err) {
      if (!(err instanceof Error && err.message === 'User not found')) throw err
    }
    return (await deps.hasTenantEvidence(subjectId)) ? { id: subjectId, username: null, email: null } : null
  }
}
