// What the panel knows about the creation order of a customer: whether
// `gremion-services wire` has run for it, and the warning for seeding a
// vertical before it has. The order is: create the customer, wire its services,
// seed the vertical. A vertical seeded first leaves every unit's chat room
// failed (the app had no bot token yet) until the next wire retries it, so the
// panel warns; it does not forbid it.
import type { PanelConfig } from '$lib/server/config'
import { controlDb } from '$lib/server/customers'

/** Shown on the customer page and returned by the seed action when the customer is not wired yet. */
export const WIRING_ORDER_WARNING =
  'Die Dienste dieses Mandanten sind noch nicht verbunden. Die Reihenfolge ist: Mandant anlegen, Dienste verbinden (auf dem Host „gremion-services wire“ für diesen Mandanten), dann die Vertikale einspielen. Wird sie vorher eingespielt, scheitern die Chat-Räume aller Einheiten, bis „wire“ sie nachholt; „wire“ lässt sich danach jederzeit wiederholen.'

/**
 * true: the wire has run for the customer; false: it has not; null: the panel cannot tell (no registry row, or the
 * registry is not readable: logged), and then nothing is claimed.
 *
 * The wire marks the registry row (domain_profile.servicesWiredAt). A customer wired before that mark existed is
 * recognised by the smtp entry the same wire step wrote under the relay transport (nothing else writes it). Only
 * the two marks are read, never the relay settings that share the column.
 */
export async function servicesWired(config: PanelConfig, slug: string): Promise<boolean | null> {
  try {
    const rows = await controlDb(config)<{ wired: boolean }[]>`
      SELECT (domain_profile ->> 'servicesWiredAt' IS NOT NULL OR domain_profile -> 'smtp' IS NOT NULL) AS wired
        FROM tenant WHERE slug = ${slug}`
    return rows[0] ? rows[0].wired : null
  } catch (err) {
    const e = err as { code?: string }
    console.error(`[control-panel] wiring state ${slug} read failed: ${e?.code ?? 'no-sqlstate'}`)
    return null
  }
}
