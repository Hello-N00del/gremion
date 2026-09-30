// "Neuer Mandant" (FLOW-OPS-001 A-D, Q6). Disabled -- visibly, with the
// reason -- when no platform database or no executor is configured. Enabled,
// it validates and starts `gremion-tenant create` as the signed-in operator;
// gremion-tenant registers the control row and the pending ledger first, and
// the status page shows the ledger filling.
import { error, fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { loadConfig, newCustomerDisabledReason, resolveOnPath } from '$lib/server/config'
import { startCreate, validateNewCustomer, type NewCustomerInput } from '$lib/server/executor'
import type { Actions, PageServerLoad } from './$types'

export const load: PageServerLoad = () => {
  const r = loadConfig(env)
  if (!r.ok) error(503, 'the control panel is not configured')
  return { disabled: newCustomerDisabledReason(r.config) }
}

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const r = loadConfig(env)
    if (!r.ok) error(503, 'the control panel is not configured')
    if (!locals.operator) error(403, 'not signed in through the ops realm')
    const disabled = newCustomerDisabledReason(r.config)
    if (disabled) return fail(409, { disabled, errors: {} as Record<string, string>, values: {} })
    const form = await request.formData()
    const input: NewCustomerInput = {
      slug: String(form.get('slug') ?? '').trim(),
      host: String(form.get('host') ?? '').trim().toLowerCase(),
      itAdmin: String(form.get('itAdmin') ?? '').trim(),
      councilAdmin: String(form.get('councilAdmin') ?? '').trim(),
      enable: form.getAll('enable').map(String),
      configFile: String(form.get('configFile') ?? '').trim(),
    }
    const errors = validateNewCustomer(input)
    if (!input.configFile.startsWith('/')) errors.configFile = 'Absoluter Pfad der Mandantenkonfiguration auf dem Host.'
    if (Object.keys(errors).length) return fail(400, { disabled: null, errors, values: input })
    // newCustomerDisabledReason already required gremion-tenant on PATH; resolve it once more for the exact path.
    const command = resolveOnPath('gremion-tenant')
    if (command === null) return fail(409, { disabled: newCustomerDisabledReason(r.config), errors: {} as Record<string, string>, values: input })
    try {
      // resolves only once the child is running; a failed start (ENOENT, EACCES) rejects here
      await startCreate(input, locals.operator.id, { command })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unbekannt'
      console.error(`[control-panel] Neuer Mandant ${input.slug}: gremion-tenant could not be started (${code})`)
      return fail(500, {
        disabled: null,
        errors: { form: `gremion-tenant konnte nicht gestartet werden (${code}); es wurde nichts angelegt. Details im Panel-Log.` } as Record<string, string>,
        values: input,
      })
    }
    redirect(303, `/customers/${input.slug}`)
  },
}
