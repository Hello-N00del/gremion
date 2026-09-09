// src/lib/server/mail/tenant-mail.ts
// SP-2 §2 — the ONE per-tenant mail seam. Two entry points:
//   - getTenantMailContext(): a transport bound to the CURRENT ALS tenant, for
//     IN-KERNEL producers (the notification scheduler + the monolith newsletter
//     sender, both already running inside a runWithTenant scope).
//   - sendMailForTenant(msg): a send-in-kernel wrapper the EXTRACTED newsletter
//     leaf (SP-3) reaches via a `POST /api/internal/newsletter/send-mail` kernel
//     callback — so SMTP credentials NEVER leave the kernel (SP-3 Option B2).
//
// Host/port/from come from the tenant's config.smtp (the Settings wizard editor),
// with an optional registry domain_profile.smtp override (ctx.services.smtp). The
// CREDENTIAL is ALWAYS a secret REF resolved via resolveSecret — the default
// tenant carries no ref ⇒ auth: undefined ⇒ byte-identical auth-less transport.
//
// Cached per canonical tenant.id for RESOLUTION_CACHE_TTL_MS (uniform with every
// other per-tenant runtime handle); evicted on suspend/delete/re-provision via
// evictTenantRuntime → evictTenantMail (closes pooled sockets).
import nodemailer from 'nodemailer'
import { readConfig } from '$lib/server/config'

// nodemailer exports `Transporter` as a namespace (not a usable type alias), so
// derive the transport type from createTransport's return type instead.
type Transporter = ReturnType<typeof nodemailer.createTransport>
import { getTenant } from '$lib/server/tenant/context'
import { resolveSecret } from '$lib/server/tenant/secrets'
import { RESOLUTION_CACHE_TTL_MS } from '$lib/server/tenant/registry'

export interface TenantMailContext {
  /** nodemailer transport bound to THIS tenant's host/port/secure/auth. */
  readonly transport: Transporter
  /** RFC-5322 From header for this tenant ("Name <addr>" or bare addr). */
  readonly from: string
  /** True iff smtp.configured — callers MUST skip/throw when false. */
  readonly configured: boolean
}

/** Thrown by sendMailForTenant when the tenant's SMTP is not configured. SP-3's
 *  T11 maps this to the `smtp-unconfigured` response (NOT a 500). */
export class SmtpUnconfiguredError extends Error {
  constructor(tenantId: string) {
    super(`smtp-unconfigured for tenant ${tenantId}`)
    this.name = 'SmtpUnconfiguredError'
  }
}

interface Entry {
  ctx: TenantMailContext
  expiresAt: number
}
// Keyed by canonical tenant.id (registry/runtime-handle convention) — NOT slug,
// NOT host. evictTenantMail(tenantId) drops one entry; the resolution cache holds
// the config, this cache holds the built transport (pooled sockets + a resolved
// secret-file read are the expensive parts worth caching across 60s ticks).
const _cache = new Map<string, Entry>()

/**
 * Resolve the CURRENT ALS tenant's mail context. Fail-closed: called outside a
 * runWithTenant scope, getTenant() throws (the desired posture — no ambient
 * default). Both in-kernel producers already run inside a per-tenant scope
 * (forEachActiveTenant / the request ALS), so this is always in-scope there.
 */
export function getTenantMailContext(): TenantMailContext {
  const tenant = getTenant() // fail-closed outside ALS
  const cached = _cache.get(tenant.id)
  if (cached && cached.expiresAt > Date.now()) return cached.ctx

  const cfg = readConfig().smtp
  const svc = tenant.services?.smtp
  // O-1: host/port/from come from config.smtp; an optional registry override
  // (svc) wins when present. The CREDENTIAL (user + passwordRef) lives ONLY in
  // the registry — config.json never holds it.
  const host = svc?.host ?? cfg.host
  const port = svc?.port ?? cfg.port
  const from =
    svc?.from ?? (cfg.from_name ? `"${cfg.from_name}" <${cfg.from_address}>` : (cfg.from_address ?? ''))
  // SP-2 review LOW-4/5: a passwordRef without a user would build
  // auth:{user:undefined} and authenticate with an empty username instead of
  // failing closed. Require the pair — surface the misconfiguration loudly.
  if (svc?.passwordRef && !svc.user) {
    throw new Error(`tenant ${tenant.id} SMTP misconfigured: passwordRef set but no user`)
  }
  // resolveSecret fail-closes on a bad scheme / missing env / path escape — a
  // misconfigured ref throws loudly rather than sending unauthenticated.
  const auth = svc?.passwordRef ? { user: svc.user, pass: resolveSecret(svc.passwordRef) } : undefined

  const transport = nodemailer.createTransport({
    host,
    port,
    // O-5: implicit TLS only on 465; nodemailer auto-STARTTLSes on 587.
    secure: port === 465,
    auth,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  })

  const ctx: TenantMailContext = { transport, from, configured: Boolean(cfg.configured) }
  _cache.set(tenant.id, { ctx, expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS })
  return ctx
}

/**
 * Send one message through the CURRENT ALS tenant's transport. The single
 * send-in-kernel seam SP-3's cross-process leaf wraps 1:1 — SMTP credentials
 * never leave the kernel. Throws SmtpUnconfiguredError when !configured.
 */
export async function sendMailForTenant(msg: {
  to: string
  subject: string
  html: string
  from_address?: string
  from_name?: string
}): Promise<{ messageId: string }> {
  const mail = getTenantMailContext()
  if (!mail.configured) throw new SmtpUnconfiguredError(getTenant().id)
  const from =
    msg.from_name && msg.from_address
      ? `"${msg.from_name}" <${msg.from_address}>`
      : (msg.from_address ?? mail.from)
  const info = await mail.transport.sendMail({
    from,
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
  })
  return { messageId: String(info.messageId) }
}

/**
 * Drop one tenant's cached mail context and close its transport (release pooled
 * sockets). Called from registry.evictTenantRuntime alongside the other
 * per-tenant handle evictions — a suspended tenant cannot keep an open SMTP
 * connection, and a re-provisioned tenant picks up rotated credentials on the
 * next resolution. Fire-and-forget close (mirrors the pool-registry drain idiom).
 */
export function evictTenantMail(tenantId: string): void {
  const entry = _cache.get(tenantId)
  if (!entry) return
  _cache.delete(tenantId)
  try {
    entry.ctx.transport.close()
  } catch (err) {
    console.error(`[tenant-mail] closing evicted transport for tenant ${tenantId} failed:`, err)
  }
}

/** Test-only: clear the per-tenant transport cache. */
export function _resetTenantMailForTests(): void {
  _cache.clear()
}
