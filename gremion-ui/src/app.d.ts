import type { SessionUser } from '$lib/auth/types'
import type { TenantContext } from '$lib/server/tenant/context'

declare global {
  namespace App {
    /**
     * Shape of `page.error`. `errId` is a server-generated `ERR-XXXXXX`
     * reference attached by `handleError` (hooks.server.ts) on unexpected
     * (500) errors so the user can quote it to the IT team (v5 Task 4.4).
     */
    interface Error {
      message: string
      errId?: string
    }
    interface Locals {
      /** Authenticated user — set by authGuard in hooks.server.ts after session validation. */
      user: SessionUser | null
      /**
       * Single source of truth for the upstream (Keycloak) access token used to
       * call StuFis and other backend services. Set by authGuard in hooks.server.ts
       * from either the Auth.js session (web) or a verified Bearer JWT (mobile/external).
       * G-006 closure: routes MUST read this instead of calling `await locals.auth()`
       * a second time to fish the access token out of the session.
       */
      accessToken: string | null
      /**
       * Unix-epoch milliseconds at which `accessToken` expires (mirror of the
       * Auth.js JWT `accessTokenExpires`). Set by authGuard alongside
       * `accessToken`. Used by the files API to instrument the intermittent
       * Nextcloud bearer-rejection failure (#161) — it lets the diagnostic log
       * record whether the bearer was already expired when WebDAV rejected it.
       * `null` for bearer-JWT (mobile) sessions and unauthenticated requests.
       */
      accessTokenExpires: number | null
      /**
       * Request-scoped tenant, resolved by tenantResolveHandle (sequence
       * element 0) from the trusted edge-forwarded host. Canonical carrier for
       * the per-tenant data plane (spec §7.1). Only null on the resolver's own
       * 404/503 short-circuit responses, which return before any downstream
       * handle reads it.
       */
      tenant: TenantContext
      /**
       * P2.1c (T4): true when the request proved internal-trust — a valid
       * constant-time `x-internal-host-trust` secret from `internalFetch`'s
       * server-to-server hop. Set by tenantResolveHandle alongside `tenant`.
       * The (T5) edge proxy-trust gate honors this as an OR so an internalFetch
       * call survives without the edge proxy-trust header. Absent on the
       * resolver's own 404/503 short-circuits (which return before any
       * downstream handle reads locals).
       */
      tenantSelectionTrusted: boolean
      /**
       * T16 (P1 correlation-id wiring): request-scoped correlation id, set by
       * the leading correlationHandle in hooks.server.ts from the inbound
       * x-correlation-id header (read-or-mint, propagation rule 5 — never
       * trusted for auth; re-minted when absent, oversized, or non-UUID).
       * Downstream handles and internalFetch forward this id so a single
       * request chain is traceable across async hops and log lines.
       */
      correlationId: string
    }
  }
}

export {}
