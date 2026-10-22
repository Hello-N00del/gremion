// The customer list: the control registry, and the ledger when configured.
import { env } from '$env/dynamic/private'
import { loadConfig, newCustomerDisabledReason, type PanelConfig } from '$lib/server/config'
import { listCustomers, platformDb } from '$lib/server/customers'
import { heartbeatAgeSeconds } from '$lib/server/requests'
import type { PageServerLoad } from './$types'

/** Why "Neuer Mandant" is disabled (A9), the executor heartbeat read now; a database that cannot be read is "no heartbeat". */
async function disabledReason(c: PanelConfig): Promise<string | null> {
  const p = platformDb(c)
  let age: number | null = null
  if (p) age = await heartbeatAgeSeconds(p).catch(() => null)
  return newCustomerDisabledReason(c, age)
}

export const load: PageServerLoad = async () => {
  const r = loadConfig(env)
  if (!r.ok) return { customers: [], error: 'Die Konfiguration ist unvollständig.', newCustomerDisabled: null }
  try {
    return { customers: await listCustomers(r.config), error: null, newCustomerDisabled: await disabledReason(r.config) }
  } catch (err) {
    // logged with its SQLSTATE and message (never a connection string): the
    // list reads the control registry AND, when configured, the platform ledger
    const e = err as { code?: string; message?: string }
    console.error(`[control-panel] customer list failed: ${e?.code ?? 'no-sqlstate'}: ${e?.message ?? String(err)}`)
    return { customers: [], error: 'Die Mandantenliste ist nicht erreichbar (Kontroll- oder Plattform-Datenbank; Details im Panel-Log).', newCustomerDisabled: await disabledReason(r.config) }
  }
}
