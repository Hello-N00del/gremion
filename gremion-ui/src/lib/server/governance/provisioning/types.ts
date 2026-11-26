// src/lib/server/governance/provisioning/types.ts
import type { OrgUnit } from '../org-units-db'

export type Subsystem = 'keycloak' | 'matrix' | 'nextcloud'
export type ResourceStatus = 'pending' | 'ok' | 'failed'

export type MemberOpStatus = 'pending' | 'ok' | 'failed'
export interface MemberOp {
  id: string
  org_unit_id: string
  user_keycloak_id: string
  subsystem: Subsystem
  op: 'remove'
  status: MemberOpStatus
  attempts: number
  next_attempt_at: string | null
  first_failed_at: string | null
  last_error: string | null
  created_at: string
}

/** Cross-subsystem inputs an adapter may need at provision time. */
export interface ProvisionContext {
  /** The parent org-unit's Keycloak group id, or null for a top-level node. */
  readonly parentKeycloakGroupId: string | null
  /**
   * Writes an external id onto this resource's ledger row WITHOUT marking it ok. An adapter whose
   * provisioning takes more than one external step calls it as soon as the first step has produced
   * something that must not be created twice, so a failure in a later step leaves the id behind and
   * the retry (which receives it as `existing`) continues with that resource. Optional: callers
   * outside the orchestrator may omit it.
   */
  readonly recordExternalId?: (externalId: string) => Promise<void>
}

/**
 * One external system. Implementations live in ./subsystems/*.
 * Every method must be idempotent — the engine may call it repeatedly.
 */
export interface ProvisioningSubsystem {
  readonly name: Subsystem
  /** Create (or verify+reuse `existing`) this node's resource. Returns its external id.
   *  `existing` is whatever the ledger row holds: the id of a finished resource whose later step
   *  (member sync) failed, or one recorded through `ctx.recordExternalId` by an attempt that stopped
   *  half way. */
  ensureResource(unit: OrgUnit, ctx: ProvisionContext, existing: string | null): Promise<{ externalId: string }>
  /** Tear the resource down. */
  removeResource(externalId: string): Promise<void>
  /** Add one member. A no-op if already present. */
  addMember(externalId: string, userKeycloakId: string): Promise<void>
  /** Remove one member. A no-op if already absent. */
  removeMember(externalId: string, userKeycloakId: string): Promise<void>
  /** Ensure every id in `desiredUserIds` is a member (additive — does not remove extras). */
  reconcileMembers(externalId: string, desiredUserIds: readonly string[]): Promise<void>
}

export interface SubsystemResult {
  subsystem: Subsystem
  status: 'ok' | 'failed' | 'skipped'
  error?: string
  willRetry: boolean
}

export interface ProvisioningReport {
  orgUnitId: string
  overall: 'ok' | 'degraded' | 'failed'
  subsystems: SubsystemResult[]
}

/** Registry of the three adapters. Injectable so tests can pass fakes. */
export interface Adapters {
  keycloak: ProvisioningSubsystem
  matrix: ProvisioningSubsystem
  nextcloud: ProvisioningSubsystem
}
