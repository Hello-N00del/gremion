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
  } catch (err) {
    // logged with its SQLSTATE and message (never a connection string): the
    // list reads the control registry AND, when configured, the platform ledger
    const e = err as { code?: string; message?: string }
    console.error(`[control-panel] customer list failed: ${e?.code ?? 'no-sqlstate'}: ${e?.message ?? String(err)}`)
    return { customers: [], error: 'Die Mandantenliste ist nicht erreichbar (Kontroll- oder Plattform-Datenbank; Details im Panel-Log).', newCustomerDisabled: newCustomerDisabledReason(r.config) }
  }
}
