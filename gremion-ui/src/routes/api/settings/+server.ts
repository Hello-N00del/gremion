import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { readConfig, writeConfig } from '$lib/server/config'
import { writeAuditEntry } from '$lib/server/audit-db'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { z } from 'zod'
import type { ApiResponse } from '$lib/api-response'

// G-098: `.strict()` rejects unknown top-level keys (e.g. typos). Per-field
// constraints below remain tighter than the baseline `configUpdateSchema`
// exported from `$lib/server/config` — this schema is intentionally a
// superset/refinement, and `writeConfig` re-validates against the baseline
// as a defensive second gate.
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
  retention: z
    .object({
      access_logs_days: z.number().int().min(1).max(30).optional(),
      app_logs_days: z.number().int().min(1).max(90).optional(),
      security_logs_days: z.number().int().min(1).max(180).optional(),
      security_nopii_logs_days: z.number().int().min(1).max(365).optional(),
    })
    .optional(),
  compliance: z
    .object({
      dpo_name: z.string().max(200).optional(),
      dpo_email: z.string().email().max(200).optional(),
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
  const parsed = settingsPatchSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const legalContext: Record<string, string> = {
      'retention.access_logs_days': 'Max 30 Tage gemäß BayLDA-Empfehlung (DSGVO Art. 5 Abs. 1 lit. e)',
      'retention.app_logs_days': 'Max 90 Tage gemäß DSGVO Art. 5 Abs. 1 lit. e + Art. 6 Abs. 1 lit. f',
      'retention.security_logs_days': 'Max 180 Tage gemäß BSI-Mindeststandard Protokollierung v2.1',
      'retention.security_nopii_logs_days': 'Max 365 Tage gemäß BSI-Mindeststandard Ausnahmeregelung',
    }
    const path = issue?.path.join('.') ?? ''
    const message = legalContext[path] ?? issue?.message ?? 'Invalid input'
    return json({ success: false, error: message }, { status: 422 })
  }

  const config = readConfig()
  const updated = writeConfig(parsed.data)

  // Audit any retention changes
  if (parsed.data.retention) {
    const userId = user.id ?? 'unknown'
    for (const [field, newVal] of Object.entries(parsed.data.retention)) {
      if (newVal !== undefined) {
        const oldVal = String(config.retention[field as keyof typeof config.retention])
        await writeAuditEntry({
          userId,
          field: `retention.${field}`,
          oldValue: oldVal,
          newValue: String(newVal),
        })
      }
    }
  }

  return json({ success: true, data: updated })
}
