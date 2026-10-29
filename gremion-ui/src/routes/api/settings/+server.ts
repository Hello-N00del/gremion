import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { readConfig, writeConfig } from '$lib/server/config'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { z } from 'zod'
import { env } from '$env/dynamic/private'
import { isAllowedSmtpPort, resolveSmtpTarget } from '$lib/server/mail/smtp-target-guard'

// G-098: `.strict()` rejects unknown top-level keys (e.g. typos). Per-field
// constraints below remain tighter than the baseline `configUpdateSchema`
// exported from `$lib/server/config` — this schema is intentionally a
// superset/refinement, and `writeConfig` re-validates against the baseline
// as a defensive second gate.
//
// TASK-033-a (Q6): there is NO `retention` key. The log deletion windows are
// fixed by the retention registry (packages/retention) and enforced by the host
// purge and the log store's own configuration; an admin cannot lengthen them.
// PATCH refuses the whole key with 400 before the schema runs.
const settingsPatchSchema = z.strictObject({
  org: z
    .object({
      name: z.string().max(200).optional(),
      domain: z.union([z.string().min(1).max(253), z.literal('')]).optional(),
      logo_path: z.string().nullable().optional(),
      portal_sections: z.record(z.string(), z.boolean()).optional(),
    })
    .optional(),
  smtp: z
    .object({
      configured: z.boolean().optional(),
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      from_address: z.string().optional(),
      from_name: z.string().optional(),
    })
    .optional(),
  // WP3-modules-dynamic: an open string→boolean record so a net-new toggleable
  // module's id is patchable here with zero edits (mirrors config's
  // modulesSchema). writeConfig still force-pins required modules to `true`.
  modules: z.record(z.string(), z.boolean()).optional(),
  elections: z
    .object({
      tracked_uuids: z.array(z.string()).optional(),
    })
    .optional(),
  legal: z
    .object({
      datenschutz_html: z.string().optional(),
      impressum_html: z.string().optional(),
      barrierefreiheit_html: z.string().optional(),
    })
    .optional(),
  backups: z
    .object({
      retention_days: z.number().int().min(7).optional(),
      encryption_key_path: z.string().optional(),
    })
    .optional(),
  compliance: z
    .object({
      dpo_name: z.string().max(200).optional(),
      // An empty DPO e-mail is a valid "not set" (F1-FIX-10-K, K2#3).
      dpo_email: z.union([z.string().email().max(200), z.literal('')]).optional(),
      controller_name: z.string().max(200).optional(),
      controller_address: z.string().max(500).optional(),
      purpose_description: z.string().max(2000).optional(),
    })
    .optional(),
})

// GET — it-admin only; returns current config (excludes wizard_steps)
export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const config = readConfig()
  const { wizard_steps: _, ...rest } = config
  return json({ success: true, data: rest })
}

// PATCH — it-admin only; partial config update
export const PATCH: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  if (body !== null && typeof body === 'object' && 'retention' in body) {
    return json(
      { success: false, error: 'Die Löschfristen für Protokolle sind fest vorgegeben und können nicht geändert werden.' },
      { status: 400 },
    )
  }
  const parsed = settingsPatchSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return json({ success: false, error: issue?.message ?? 'Invalid input' }, { status: 422 })
  }

  // MED-4: hold the SMTP host/port to the same guard as /api/setup/test-smtp
  // (internal names, private/loopback ranges, non-SMTP ports). The guard runs on
  // the MERGED stored+patch values whenever host or port is touched, so a
  // host-only / port-only PATCH cannot keep a bad stored counterpart.
  const config = readConfig()
  const smtp = parsed.data.smtp
  if (smtp && (smtp.host !== undefined || smtp.port !== undefined)) {
    const merged = { ...(config.smtp as { host?: string; port?: number } | undefined), ...smtp }
    if (merged.port !== undefined && !isAllowedSmtpPort(merged.port, env.SMTP_TEST_ALLOW_PRIVATE === '1')) {
      return json(
        { success: false, error: 'SMTP-Port ist nicht zugelassen (erlaubt: 25, 465, 587, 2525)' },
        { status: 400 },
      )
    }
    if (merged.host) {
      const target = await resolveSmtpTarget(merged.host)
      if (!target.allowed) {
        return json(
          {
            success: false,
            error:
              target.reason === 'dns'
                ? 'SMTP-Host konnte nicht aufgelöst werden'
                : 'SMTP-Host ist keine erlaubte externe Adresse',
          },
          { status: 400 },
        )
      }
    }
  }

  const updated = writeConfig(parsed.data)
  return json({ success: true, data: updated })
}
