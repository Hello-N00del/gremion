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
import { currentTenantId } from '$lib/server/tenant/context'


const smtpTestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string(),
  password: z.string(),
  from_address: z.string().email(),
  to_address: z.string().email(),
})

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

  const body = await request.json()
  const parsed = smtpTestSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    )
  }

  const { host, port, user, password, from_address, to_address } = parsed.data

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

  const transporter = nodemailer.createTransport({
    // Dial the address that was actually vetted, not the name — re-resolving
    // here would reopen the DNS-rebinding window the guard just closed.
    host: target.connectHost,
    port,
    secure: port === 465,
    auth: user ? { user, pass: password } : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    ...(target.servername ? { tls: { servername: target.servername } } : {}),
  })

  try {
    await transporter.sendMail({
      from: from_address,
      to: to_address,
      subject: 'Gremion SMTP-Test',
      text: 'Diese E-Mail bestätigt, dass die SMTP-Konfiguration erfolgreich ist.',
    })
    return json({ success: true, data: { success: true } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unbekannter Fehler'
    return json({
      success: false,
      data: { success: false, error: message },
    })
  }
}
