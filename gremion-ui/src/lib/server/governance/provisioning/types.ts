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
}

/**
 * One external system. Implementations live in ./subsystems/*.
 * Every method must be idempotent — the engine may call it repeatedly.
 */
export interface ProvisioningSubsystem {
  readonly name: Subsystem
  /** Create (or verify+reuse `existing`) this node's resource. Returns its external id. */
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
