import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { readConfig, writeConfig } from '$lib/server/config'
import { writeAuditEntry } from '$lib/server/audit-db'
import { OPERATOR_DECISION_DE, RETENTION_CAPS } from '$lib/retention-tiers'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { z } from 'zod'

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
      // [D R29-I6]: bounds come from the one tier registry (`$lib/retention-tiers`).
      access_logs_days: z.number().int().min(1).max(RETENTION_CAPS.access_logs_days).optional(),
      app_logs_days: z.number().int().min(1).max(RETENTION_CAPS.app_logs_days).optional(),
      security_logs_days: z.number().int().min(1).max(RETENTION_CAPS.security_logs_days).optional(),
      security_nopii_logs_days: z.number().int().min(1).max(RETENTION_CAPS.security_nopii_logs_days).optional(),
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
  const parsed = settingsPatchSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    // [D R29-I6]: the cap message names the operator ceiling (no log class is
    // kept longer than 30 days), not the earlier per-class tiers. Only an
    // over-the-cap value gets it; 0 or a fraction keeps zod's own message.
    const capMessage = (field: keyof typeof RETENTION_CAPS) =>
      `Max ${RETENTION_CAPS[field]} Tage (Betreiber-Obergrenze 30 Tage für jede Protokollklasse, ${OPERATOR_DECISION_DE})`
    const legalContext: Record<string, string> = {
      'retention.access_logs_days': capMessage('access_logs_days'),
      'retention.app_logs_days': capMessage('app_logs_days'),
      'retention.security_logs_days': capMessage('security_logs_days'),
      'retention.security_nopii_logs_days': capMessage('security_nopii_logs_days'),
    }
    const path = issue?.path.join('.') ?? ''
    const message = (issue?.code === 'too_big' ? legalContext[path] : undefined) ?? issue?.message ?? 'Invalid input'
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
