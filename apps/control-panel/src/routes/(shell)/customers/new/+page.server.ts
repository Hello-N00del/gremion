// "Neuer Mandant" (FLOW-OPS-001 A-D, Q6; TASK-043d D7/D8/D9). The panel writes a
// REQUEST (plt.submit_provisioning_request) and nothing else; the host-side
// executor verifies the operator's signed sign-in again and runs the create.
// Disabled -- visibly, with the reason -- when no platform database, no queue
// executor or no fresh executor heartbeat exists (A9). The form never names a
// host path: slug, host, two administrators, the first body, the brand and
// the module checkboxes (no module ticked by default).
import { randomUUID } from 'node:crypto'
import { error, fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { evidenceFromRequest } from '$lib/server/auth'
import { loadConfig, newCustomerDisabledReason, type PanelConfig } from '$lib/server/config'
import { platformDb } from '$lib/server/customers'
import { heartbeatAgeSeconds, listModuleChoices, submitCreate, SubmitRefused, validateNewCustomer, type ModuleChoice, type NewCustomerInput } from '$lib/server/requests'
import type { Actions, PageServerLoad } from './$types'

/** A text field, trimmed; a file part or an absent field is the empty string (never "[object File]"). */
function textField(form: FormData, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

/** The reason "Neuer Mandant" is disabled, read now (heartbeat included), and the modules to offer. */
async function situation(c: PanelConfig) {
  const p = platformDb(c)
  let age: number | null = null
  let modules: ModuleChoice[] = []
  if (p) {
    try {
      age = await heartbeatAgeSeconds(p)
      modules = await listModuleChoices(p)
    } catch (err) {
      const e = err as { code?: string; message?: string }
      console.error(`[control-panel] Neuer Mandant: platform database not readable: ${e?.code ?? 'no-sqlstate'}: ${e?.message ?? String(err)}`)
    }
  }
  return { disabled: newCustomerDisabledReason(c, age), modules }
}

export const load: PageServerLoad = async () => {
  const r = loadConfig(env)
  if (!r.ok) error(503, 'the control panel is not configured')
  const s = await situation(r.config)
  // the idempotency key of THIS form: a re-post of it never writes a second row
  return { disabled: s.disabled, modules: s.modules, key: randomUUID() }
}

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const r = loadConfig(env)
    if (!r.ok) error(503, 'the control panel is not configured')
    if (!locals.operator) error(403, 'not signed in through the ops realm')
    const s = await situation(r.config)
    const empty = {} as Record<string, string>
    if (s.disabled) return fail(409, { disabled: s.disabled, errors: empty, values: {}, key: randomUUID() })
    const p = platformDb(r.config)
    if (!p) return fail(409, { disabled: newCustomerDisabledReason(r.config, null), errors: empty, values: {}, key: randomUUID() })
    const form = await request.formData()
    const enable = form.getAll('enable').filter((v): v is string => typeof v === 'string')
    const dpia: NewCustomerInput['dpia'] = {}
    // an explicit ja/nein per module: anything but yes/no stays null and is refused by validateNewCustomer
    for (const id of enable) {
      const answer = textField(form, `dpia_${id}`)
      dpia[id] = { requiresDpia: answer === 'yes' ? true : answer === 'no' ? false : null, documentRef: textField(form, `dpiaRef_${id}`) }
    }
    const input: NewCustomerInput = {
      slug: textField(form, 'slug'),
      host: textField(form, 'host').toLowerCase(),
      itAdmin: textField(form, 'itAdmin'),
      councilAdmin: textField(form, 'councilAdmin'),
      bodyName: textField(form, 'bodyName'),
      brandProduct: textField(form, 'brandProduct'),
      brandOrgShort: textField(form, 'brandOrgShort'),
      enable,
      dpia,
    }
    const key = textField(form, 'key')
    const errors = validateNewCustomer(input)
    if (Object.keys(errors).length) return fail(400, { disabled: null, errors, values: input, key })
    // the signed sign-in, read server-side from the encrypted session; never sent to the browser
    const evidence = await evidenceFromRequest(request, r.config)
    if (!evidence) return fail(403, { disabled: null, errors: { form: 'Die Anmeldung trägt keinen Nachweis (loa2). Bitte neu anmelden.' } as Record<string, string>, values: input, key })
    try {
      await submitCreate(p, input, locals.operator.id, key, evidence)
    } catch (err) {
      if (err instanceof SubmitRefused) return fail(err.status, { disabled: null, errors: { form: err.message } as Record<string, string>, values: input, key })
      throw err
    }
    redirect(303, `/customers/${input.slug}`)
  },
}
