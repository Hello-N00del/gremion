// The customer list: the control registry, and the ledger when configured.
import { env } from '$env/dynamic/private'
import { loadConfig, newCustomerDisabledReason } from '$lib/server/config'
import { listCustomers } from '$lib/server/customers'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async () => {
  const r = loadConfig(env)
  if (!r.ok) return { customers: [], error: 'Die Konfiguration ist unvollständig.', newCustomerDisabled: null }
  try {
    return { customers: await listCustomers(r.config), error: null, newCustomerDisabled: newCustomerDisabledReason(r.config) }
  } catch {
    return { customers: [], error: 'Die Mandantenliste ist nicht erreichbar (Kontroll-Datenbank).', newCustomerDisabled: newCustomerDisabledReason(r.config) }
  }
}
