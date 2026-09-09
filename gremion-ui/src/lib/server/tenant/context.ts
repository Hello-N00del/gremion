// src/lib/server/tenant/context.ts
// The ONE canonical request-scoped tenant carrier (P2.1a, spec §3.2/§7).
// A single AsyncLocalStorage<TenantContext> keyed by one canonical registry
// tenant id — no host-vs-id-vs-DATABASE_URL ambiguity. AsyncLocalStorage is
// introduced from scratch by this pillar.
//
// FAIL-CLOSED CONTRACT (spec §1.7): an accessor invoked with NO active context
// MUST THROW. It must NEVER silently default to tenant #1. Out-of-request entry
// points (boot, cron, setInterval) must wrap work in runWithTenant().
//
// Pure plumbing: reads NO env and builds NO clients. It only carries a
// pre-resolved descriptor that the resolver/rebind clusters populate.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Sql } from '@gremion/db'
import type { Brand } from '$lib/brand'
import type { GremionConfig } from '$lib/server/config'
import type { KeycloakAdminClient } from '$lib/server/keycloak-admin'

/**
 * P2.1b T7 — per-tenant external-service endpoints/secret refs, resolved by
 * the registry from `matrix_space` / `domain_profile` JSONB. All fields are
 * OPTIONAL: an absent field falls back to env at the consuming module. The
 * DEFAULT tenant NEVER reads these — its env expressions stay the source of
 * truth (standing rule 6, byte-identical), so the per-tenant modules branch on
 * `slug === 'default'` BEFORE consulting `services`.
 */
export interface TenantServices {
  readonly matrixUrl?: string
  readonly synapseAdminTokenRef?: string
  readonly synapseAdminBotUserId?: string
  readonly synapseServerName?: string
  readonly heliosUrl?: string
  readonly livekitUrl?: string
  readonly livekitApiKeyRef?: string
  readonly livekitApiSecretRef?: string
  /** SP-2: per-tenant SMTP credential ref + optional host/port/from override.
   *  Sourced from the registry row's domain_profile.smtp. ABSENT on the default
   *  tenant ⇒ the mail seam falls back to config.smtp + auth-less (byte-identical
   *  to today). The credential is ALWAYS a secret REF (resolveSecret), never raw. */
  readonly smtp?: {
    readonly host?: string
    readonly port?: number
    readonly from?: string
    readonly user?: string
    readonly passwordRef?: string
  }
}

/** A fully-resolved per-tenant descriptor. One canonical id keys every field. */
export interface TenantContext {
  readonly id: string
  readonly slug: string
  readonly db: Sql
  readonly issuer: string
  readonly kcInternal: string
  readonly audiences: readonly string[]
  readonly kcAdminClient: KeycloakAdminClient
  readonly realmName: string
  readonly kcAdminUrl: string
  readonly kcClientId: string
  readonly kcClientSecretRef: string
  readonly authExternalBase: string
  readonly authClientId: string
  readonly authClientSecretRef: string
  readonly brand: Brand
  readonly config: GremionConfig
  readonly aliasNamespace: string
  readonly accent: string | null
  readonly logoUrl: string | null
  readonly configPath: string
  readonly dbUrl: string
  readonly dbMax: number
  readonly dbPrepare: boolean
  /** P2.1b T7 — optional per-tenant service endpoints (see TenantServices). */
  readonly services?: TenantServices
}

const als = new AsyncLocalStorage<TenantContext>()

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return als.run(ctx, fn)
}

export function getTenant(): TenantContext {
  const ctx = als.getStore()
  if (!ctx) {
    throw new Error(
      'No tenant context: getTenant() called outside runWithTenant(). ' +
        'Out-of-request callers must wrap per-tenant work in runWithTenant(ctx, …).',
    )
  }
  return ctx
}

/** Self-documenting alias for data-plane call sites. Same fail-closed throw. */
export function requireTenant(): TenantContext {
  return getTenant()
}

/** The canonical tenant id, or THROW. Used as the cache/pool key everywhere. */
export function currentTenantId(): string {
  return getTenant().id
}

/** Non-throwing read for cosmetic-only paths (SSR brand). Never for data. */
export function getTenantOrNull(): TenantContext | null {
  return als.getStore() ?? null
}

/** Wiring/test accessor — the singleton ALS shared by resolver + rebind. */
export function _getAls(): AsyncLocalStorage<TenantContext> {
  return als
}
