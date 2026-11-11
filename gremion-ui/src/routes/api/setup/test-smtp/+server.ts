import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { z } from 'zod'
import nodemailer from 'nodemailer'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { requireSetupRateLimit, checkAndIncrement, RATE_LIMITS } from '$lib/server/rate-limit'
import { clientIpWithReason } from '$lib/server/client-ip'
import { isAllowedSmtpPort, resolveSmtpTarget, REFUSAL_HINT, DNS_FAILURE_HINT } from '$lib/server/mail/smtp-target-guard'
import { currentTenantId, getTenant } from '$lib/server/tenant/context'
import { resolveSecret } from '$lib/server/tenant/secrets'
import { readConfig } from '$lib/server/config'
import { smtpEhloName } from '$lib/server/mail/ehlo-name'


// There is deliberately NO recipient field: the test mail goes to the signed-in
// admin's own address (the session), never to an address the request names. A
// `to_address` a client still sends is ignored. `user` / `password` are the
// OPTIONAL override; empty means "use the tenant's stored relay login".
const smtpTestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().default(''),
  password: z.string().default(''),
  from_address: z.string().email(),
})

const CLOSED_CONNECTION = /connection closed|closed unexpectedly|socket (hang up|closed)|ECONNRESET/i

/** Case-insensitive host + exact port equality, the "same relay" test. */
function sameRelay(host: string, port: number, otherHost: string | undefined, otherPort: number | undefined) {
  return !!otherHost && host.trim().toLowerCase() === otherHost.trim().toLowerCase() && port === otherPort
}

/** Why the stored login could not be used. A fixed reason, never the error text. */
class StoredLoginError extends Error {
  constructor(readonly reason: 'incomplete' | 'secret-unreadable', readonly code?: string) {
    super(reason)
  }
}

/** The error code of a failed secret read when it is a plain token; never the message. */
function safeErrorCode(err: unknown): string | undefined {
  const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : undefined
}

type StoredLogin = {
  auth?: { user: string; pass: string }
  /** A stored login exists but the target is not the relay it belongs to. */
  withheld: boolean
}

/**
 * The stored relay login, if the tenant has one AND the target is the relay real
 * sending uses. The relay is named by the registry host only: the registry is
 * written by the platform operator, whereas config.smtp.host is typed by the
 * tenant admin (Settings -> E-Mail), so a login must never follow that host. The
 * port is the registry's, else config.smtp's, as in tenant-mail.ts (it is limited
 * to the SMTP ports and cannot redirect the login to another server).
 * Throws StoredLoginError when the stored login is present but unusable.
 */
function storedLogin(host: string, port: number): StoredLogin {
  const svc = getTenant().services?.smtp
  if (!svc?.passwordRef) return { withheld: false }
  const realPort = svc.port ?? readConfig().smtp?.port
  if (!svc.host || !sameRelay(host, port, svc.host, realPort)) return { withheld: true }
  // Same rule as tenant-mail.ts: a passwordRef without a user fails closed.
  if (!svc.user) throw new StoredLoginError('incomplete')
  try {
    return { auth: { user: svc.user, pass: resolveSecret(svc.passwordRef) }, withheld: false }
  } catch (err) {
    throw new StoredLoginError('secret-unreadable', safeErrorCode(err))
  }
}

function failure(error: string) {
  return json({ success: false, data: { success: false, error } })
}

/** German, user-facing text for a failed send; the password is scrubbed from any raw text. */
function describeSendFailure(err: unknown, secrets: string[], usedLogin: boolean, withheld: boolean): string {
  const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
  const raw = err instanceof Error ? err.message : 'Unbekannter Fehler'
  if (code === 'EAUTH') {
    return 'Die Anmeldung am Mailserver wurde abgelehnt. Benutzer oder Passwort stimmen nicht.'
  }
  if (CLOSED_CONNECTION.test(raw)) {
    return (
      'Der Mailserver hat die Verbindung unerwartet geschlossen. Häufigste Ursache: Er verlangt eine ' +
      'Anmeldung (SMTP-AUTH), und Benutzer oder Passwort fehlen oder sind falsch.' +
      (usedLogin ? '' : ' Für diesen Test wurden keine Zugangsdaten gesendet.') +
      (withheld
        ? ' Die hinterlegte Anmeldung gilt nur für den vom Betreiber festgelegten Mailserver und wurde für diesen Host nicht verwendet.'
        : '')
    )
  }
  let text = raw
  for (const secret of secrets) if (secret) text = text.split(secret).join('***')
  return text
}

export const POST: RequestHandler = async (event) => {
  const { request, locals } = event
  // #257-3: rate-limit BEFORE the auth check so refused attempts still count.
  // This endpoint opens an outbound SMTP connection to a body-supplied
  // host:port, so the cap also bounds its use as an SSRF/port-probe oracle.
  const limited = requireSetupRateLimit(clientIpWithReason(event))
  if (limited) return limited
  // TASK-042 Q1 (PRD-IDN-005 [D R18-1]; OWASP 2021 A01/A05): the first-run
  // wizard and its bearer token are gone. The session plus Role.ITAdmin gates
  // this endpoint, exactly as api/settings/backup does; the authGuard already
  // refuses an unauthenticated /api/ request, and this is the handler's own
  // deny-by-default copy of that check.
  const session = await locals.auth()
  const sessionUser = session?.user as SessionUser | undefined
  if (!sessionUser) {
    return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  }
  if (!hasRole(sessionUser.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  // TASK-042 R28: the per-USER cap (same budget as the per-IP one above).
  const { limit, windowMs } = RATE_LIMITS.setup
  if (!checkAndIncrement(`${currentTenantId()}|setup:test-smtp-user:${sessionUser.id}`, limit, windowMs)) {
    return json({ success: false, error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': '60' } })
  }

  // The recipient is the admin's own address from the session, decided before any
  // socket exists. An address the request names is never used.
  const recipient = sessionUser.email
  if (!recipient || !z.string().email().safeParse(recipient).success) {
    return json(
      { success: false, error: 'Dem angemeldeten Konto ist keine E-Mail-Adresse zugeordnet.' },
      { status: 400 },
    )
  }

  const body = await request.json()
  const parsed = smtpTestSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    )
  }

  const { host, port, user, password, from_address } = parsed.data

  // A password the admin typed must never be dropped silently: "success" would then
  // vouch for a credential that was never tried.
  if (!user && password) {
    return json(
      { success: false, error: 'Zum eingegebenen Passwort fehlt der Benutzer.' },
      { status: 400 },
    )
  }

  // TASK-042 R28: SMTP ports only, decided before any DNS lookup or socket.
  if (!isAllowedSmtpPort(port, env.SMTP_TEST_ALLOW_PRIVATE === '1')) {
    return json(
      { success: false, error: 'SMTP-Port ist nicht zugelassen (erlaubt: 25, 465, 587, 2525)' },
      { status: 400 },
    )
  }

  // Refuse internal/metadata targets BEFORE a transport (and therefore a socket)
  // exists, so no timing or error-string difference leaks the probe result.
  const target = await resolveSmtpTarget(host)
  if (!target.allowed) {
    const dns = target.reason === 'dns'
    return json(
      {
        success: false,
        error: dns
          ? 'SMTP-Host konnte nicht aufgelöst werden'
          : 'SMTP-Host ist keine erlaubte externe Adresse',
        hint: dns ? DNS_FAILURE_HINT : REFUSAL_HINT,
      },
      { status: 400 },
    )
  }

  // Typed override wins; otherwise the stored relay login, the same one real
  // sending uses. Resolved only after the target guard has passed.
  let auth: { user: string; pass: string } | undefined
  let fromStore = false
  let withheld = false
  if (user) {
    auth = { user, pass: password }
  } else {
    try {
      const stored = storedLogin(host, port)
      auth = stored.auth
      withheld = stored.withheld
      fromStore = !!auth
    } catch (err) {
      if (!(err instanceof StoredLoginError)) throw err
      // Fixed reason and a plain error code only: the error text of a failed
      // secret read carries the secret's path.
      console.warn(`[test-smtp] stored relay login unusable (${err.reason}${err.code ? `:${err.code}` : ''})`)
      return failure(
        err.reason === 'incomplete'
          ? 'Die hinterlegte Anmeldung für den Mailserver ist unvollständig (Benutzer fehlt). Bitte die Hinterlegung prüfen.'
          : 'Das hinterlegte Passwort für den Mailserver konnte nicht gelesen werden. Bitte die Hinterlegung prüfen.',
      )
    }
  }

  const transporter = nodemailer.createTransport({
    // Dial the address that was actually vetted, not the name — re-resolving
    // here would reopen the DNS-rebinding window the guard just closed.
    host: target.connectHost,
    port,
    name: smtpEhloName(),
    secure: port === 465,
    auth,
    // The operator's relay secret only goes out on an upgraded connection: a
    // stripped STARTTLS capability must fail the test, not leak the login.
    ...(fromStore && port !== 465 ? { requireTLS: true } : {}),
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    ...(target.servername ? { tls: { servername: target.servername } } : {}),
  })

  try {
    await transporter.sendMail({
      from: from_address,
      to: recipient,
      subject: 'Gremion SMTP-Test',
      text: 'Diese E-Mail bestätigt, dass die SMTP-Konfiguration erfolgreich ist.',
    })
    return json({ success: true, data: { success: true } })
  } catch (err) {
    // Log the failure class only, never the message: a transport error can quote
    // the login it was given.
    const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
    console.warn(`[test-smtp] send failed${code ? ` (${code})` : ''}`)
    return failure(describeSendFailure(err, [password, auth?.pass ?? ''], !!auth, withheld))
  }
}
