// services/calendar/src/kernel-client.ts
//
// Task 16: MINIMAL kernel-client for the calendar leaf.
//
// ── ASYMMETRY vs newsletter's kernel-client (services/newsletter/src/kernel-client.ts) ──
// Newsletter's leaf owns the send pipeline but THREE privileged operations still
// live in the kernel and are reached over HTTP at send time: render(odtPath),
// resolveGroup(groupId), sendMail(msg) — see that file's header for the full
// rationale (SMTP creds/Nextcloud/Collabora/KC-admin never leave the kernel).
//
// The calendar leaf needs NONE of that. Per design §8 (CalDAV-DIRECT, no kernel
// callback): the leaf ports its own slim ICS builder (./caldav/client.ts) and
// WebDAV pusher (./caldav/pusher.ts) and talks to Nextcloud directly with admin
// Basic auth from its OWN env (NEXTCLOUD_URL / NEXTCLOUD_ADMIN_USER /
// NEXTCLOUD_ADMIN_PASSWORD / CALDAV_SHARED_USER / CALDAV_SHARED_CALENDAR) — it
// does NOT import the kernel's files/nextcloud-client, and it does NOT call
// back into the kernel to push/pull calendar data. There is therefore no
// render/resolveGroup/sendMail/portalPublish method on this client, and no
// callback route on the kernel side for calendar to hit.
//
// What THIS file exists for: the header-plumbing seam, kept identical in SHAPE
// to newsletter's (so a future kernel callback — if one is ever needed — slots in
// without re-deriving anything), but with ZERO callback methods wired up today.
// Only buildHeaders() is exposed; it produces the same header set newsletter's
// private buildHeaders() does:
//   - x-internal-auth   : the shared internal secret. A future callback guard
//                         would validate this the same way newsletter's does —
//                         and, since Tenancy D1 HARDENING-3, it is ALSO what
//                         authenticates the tenant assertion below at the
//                         kernel's element-0 resolver.
//   - x-tenant-id / x-tenant-slug : the tenant this leaf process is acting for.
//                         `x-tenant-id` is what the kernel resolver SELECTS on
//                         (gremion-ui/src/lib/server/tenant/leaf-trust.ts).
//   - x-correlation-id  : traces a future callback back to the triggering op.
//
// ⛔ There is NOTHING host-shaped here, and adding one would be a regression. A
// callback does not need a hostname: the kernel selects the tenant from the id
// above. The two shapes that used to live here are both deleted — the
// `<slug>.<apexDomain>` synthesis (a cross-tenant selector under whole-host
// lookup) and the threaded-down registered host cached in the leaf's catalog (a
// replica with no backfill for loops that have no inbound request). Whoever adds
// the first real calendar callback needs neither; see newsletter's
// kernel-client.ts for the full history.
//
// The transport is injectable (`fetchImpl`, defaulting to global fetch) so a
// future callback method can be tested against a FAKE fetch — no live kernel
// required. It is accepted here (and typed) even though no method currently
// uses it, purely to keep the options shape stable across the eventual
// addition of a real callback.

import type { TenantRef } from './tenant-store.js'

/** Minimal fetch shape so we can inject a fake without pulling in DOM libs. */
export type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}>

export interface KernelClientOptions {
  /** Base URL of the kernel internal callback API (no trailing slash needed). */
  baseUrl: string
  /** Shared internal secret — forwarded as x-internal-auth. */
  secret: string
  /** The tenant this client is bound to (forwarded as x-tenant-id / -slug). */
  tenant: TenantRef
  /** The correlation id for this operation (forwarded as x-correlation-id). */
  correlationId: string
  /** Injectable transport (defaults to global fetch). Reserved for a future callback. */
  fetchImpl?: FetchLike
}

/**
 * The minimal port: only the header-plumbing seam. NO render / resolveGroup /
 * sendMail / portalPublish — the calendar leaf has no kernel callback (design
 * §8, CalDAV is direct). A future task adding a real callback method should
 * extend THIS interface rather than reintroducing newsletter's fat surface.
 */
export interface KernelClient {
  /**
   * Build the per-request header set a future callback would forward. Exposed
   * so callers/tests can assert the SP-3 plumbing without any method actually
   * making a network call today.
   */
  buildHeaders(): Record<string, string>
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Construct a KernelClient bound to one tenant + one correlation id. Carries
 * the SP-3 header plumbing (see file header) but exposes no callback methods.
 */
export function createKernelClient(opts: KernelClientOptions): KernelClient {
  // Accepted for shape-parity with a future callback seam; unused today.
  void (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike))
  const base = trimBase(opts.baseUrl)
  void base // reserved: a future callback method will build its URL off `base`.

  return {
    buildHeaders(): Record<string, string> {
      // Tenancy D1 HARDENING-3: the COMPLETE set — see the ⛔ block at the top
      // of this file before adding anything host-shaped.
      return {
        'content-type': 'application/json',
        'x-internal-auth': opts.secret,
        'x-tenant-id': opts.tenant.id,
        'x-tenant-slug': opts.tenant.slug,
        'x-correlation-id': opts.correlationId,
      }
    },
  }
}
