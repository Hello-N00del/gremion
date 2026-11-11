import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { parseConfig, readConfig, writeConfig } from '$lib/server/config'
import { councilSwitchEnablesIn } from '$lib/server/module-switch/direct-writes'
import { platformHeldOffForCurrentTenant } from '$lib/server/module-switch/platform-held'
import { writeAuditEntry } from '$lib/server/audit-db'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'

const CONFIRM_PHRASE = 'ZURÜCKSETZEN'

// F1-FIX-10-K / K2#9: server-side "Konfiguration zurücksetzen". It rebuilds the
// organisation, SMTP, module and backup-retention sections from the real defaults
// (parseConfig({}) is DEFAULT_CONFIG through the same merge readConfig uses), so
// no module id is hard-coded in the client, and writes an audit entry. Legal
// texts, compliance data, log retention and the setup state are NOT touched: the
// UI promises exactly "Organisations-, SMTP- und Modul-Einstellungen".
// writeConfig merges one level deep, so a stored module key the defaults no
// longer list survives; that is the existing merge semantics, not hidden here.
export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    /* handled below as a missing confirmation */
  }
  if (typeof body !== 'object' || body === null || (body as { confirm?: unknown }).confirm !== CONFIRM_PHRASE) {
    return json({ success: false, error: `Bitte "${CONFIRM_PHRASE}" eingeben.` }, { status: 422 })
  }

  try {
    const defaults = parseConfig({})
    // Karenz: the defaults say "on" for every toggleable module, but a council-switchable module that is
    // off comes back only through the council switch (platform request, DPIA decision, Art. 17 replay of a
    // restore). The reset leaves such a module as it is and says so.
    const heldBack = councilSwitchEnablesIn(defaults.modules, readConfig().modules, platformHeldOffForCurrentTenant())
    const modules = Object.fromEntries(Object.entries(defaults.modules).filter(([id]) => !heldBack.includes(id)))
    const updated = writeConfig({
      org: defaults.org,
      smtp: defaults.smtp,
      modules,
      backups: { retention_days: defaults.backups.retention_days },
    })
    await writeAuditEntry({
      userId: user.id,
      field: 'config.reset',
      oldValue: 'org,smtp,modules,backups.retention_days',
      newValue: heldBack.length > 0 ? `defaults (left off, switchable only through the module switch: ${heldBack.join(',')})` : 'defaults',
    })
    return json({ success: true, data: updated, heldBack })
  } catch (err) {
    console.error('[settings/reset] failed:', err instanceof Error ? err.message : err)
    return json({ success: false, error: 'Zurücksetzen fehlgeschlagen.' }, { status: 500 })
  }
}
