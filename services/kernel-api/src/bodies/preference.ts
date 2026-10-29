// services/kernel-api/src/bodies/preference.ts -- the signed-in person's OWN
// preference (idt.preference), found by the VERIFIED idp subject.
//
// No WriteAuthorizer question: the subject IS the authority, and nothing but
// the preference is writable through it. No event: the preference is not a
// catalogue aggregate. A subject that belongs to no active person is NOT_FOUND
// (the HTTP layer answers 403 for it: never reveal who exists).
import type { Sql } from '@gremion/db'
import { BodiesError } from './errors.ts'
import { one } from './core.ts'
import { inCustomerTx } from './tx.ts'

export interface PreferenceView {
  personId: string
  locale: 'de' | 'en' | 'follow_customer'
  displayDensity: string
  colourScheme: string
  lastBodyId: string | null
  rowVersion: number
  updatedByKind: 'person' | 'system'
  updatedBy: string | null
  /** locale with follow_customer resolved through idt.customer_setting.default_locale. */
  effectiveLocale: 'de' | 'en'
  /** False until the person first saved a preference (the defaults are shown). */
  stored: boolean
}

export interface PreferencePatch {
  locale?: 'de' | 'en' | 'follow_customer'
  displayDensity?: 'standard' | 'kompakt' | 'gross'
  colourScheme?: 'system' | 'light' | 'dark'
  lastBodyId?: string | null
}

interface PrefRow {
  locale: PreferenceView['locale']
  display_density: string
  colour_scheme: string
  last_body_id: string | null
  row_version: number
  updated_by_kind: 'person' | 'system'
  updated_by: string | null
}

/** Null when the subject belongs to no active person of this customer. */
export async function readPreference(tx: Sql, customerId: string, subject: string): Promise<PreferenceView | null> {
  const [p] = await tx<{ person_id: string }[]>`SELECT person_id FROM idt.person WHERE customer_id = ${customerId}::uuid AND idp_subject = ${subject} AND account_state = 'active'`
  if (!p) return null
  const [pref] = await tx<PrefRow[]>`
    SELECT locale, display_density, colour_scheme, last_body_id, row_version::int AS row_version, updated_by_kind, updated_by
      FROM idt.preference WHERE customer_id = ${customerId}::uuid AND person_id = ${p.person_id}::uuid`
  const [cs] = await tx<{ default_locale: 'de' | 'en' }[]>`SELECT default_locale FROM idt.customer_setting WHERE customer_id = ${customerId}::uuid`
  const customerDefault = cs?.default_locale ?? 'de'
  const locale = pref?.locale ?? 'follow_customer'
  return {
    personId: p.person_id,
    locale,
    displayDensity: pref?.display_density ?? 'standard',
    colourScheme: pref?.colour_scheme ?? 'system',
    lastBodyId: pref?.last_body_id ?? null,
    rowVersion: pref?.row_version ?? 0,
    updatedByKind: pref?.updated_by_kind ?? 'system',
    updatedBy: pref?.updated_by ?? null,
    effectiveLocale: locale === 'follow_customer' ? customerDefault : locale,
    stored: pref !== undefined,
  }
}

export interface PreferenceCtx {
  sql: Sql
  customerId: string
}

export const preferenceOps = {
  getPreferenceBySubject: (ctx: PreferenceCtx, subject: string): Promise<PreferenceView | null> => inCustomerTx(ctx.sql, ctx.customerId, (tx) => readPreference(tx, ctx.customerId, subject)),

  upsertPreferenceBySubject: (ctx: PreferenceCtx, subject: string, patch: PreferencePatch): Promise<PreferenceView> =>
    inCustomerTx(ctx.sql, ctx.customerId, async (tx) => {
      const [p] = await tx<{ person_id: string }[]>`SELECT person_id FROM idt.person WHERE customer_id = ${ctx.customerId}::uuid AND idp_subject = ${subject} AND account_state = 'active'`
      const person = one(p ? [p] : [], 'no active person for this subject')
      const [cur] = await tx<{ locale: string; display_density: string; colour_scheme: string; last_body_id: string | null }[]>`
        SELECT locale, display_density, colour_scheme, last_body_id FROM idt.preference WHERE customer_id = ${ctx.customerId}::uuid AND person_id = ${person.person_id}::uuid FOR UPDATE`
      const locale = patch.locale ?? cur?.locale ?? 'follow_customer'
      const density = patch.displayDensity ?? cur?.display_density ?? 'standard'
      const scheme = patch.colourScheme ?? cur?.colour_scheme ?? 'system'
      const lastBody = patch.lastBodyId === undefined ? (cur?.last_body_id ?? null) : patch.lastBodyId
      await tx`
        INSERT INTO idt.preference (person_id, customer_id, locale, display_density, colour_scheme, last_body_id, created_by_kind, created_by, updated_by_kind, updated_by)
        VALUES (${person.person_id}::uuid, ${ctx.customerId}::uuid, ${locale}, ${density}, ${scheme}, ${lastBody}, 'person', ${person.person_id}::uuid, 'person', ${person.person_id}::uuid)
        ON CONFLICT (person_id) DO UPDATE
           SET locale = EXCLUDED.locale, display_density = EXCLUDED.display_density, colour_scheme = EXCLUDED.colour_scheme, last_body_id = EXCLUDED.last_body_id,
               updated_by_kind = 'person', updated_by = EXCLUDED.updated_by`
      const out = await readPreference(tx, ctx.customerId, subject)
      if (!out) throw new BodiesError('NOT_FOUND', 'preference')
      return out
    }),
}
