// TASK-062 (brief §3 grant: one new form action for the switch). The logic
// lives in $lib/i18n/server/switch-locale.ts; this file only binds its seams.
import type { Actions } from './$types'
import { switchLocale } from '$lib/i18n/server/switch-locale'
import { personIdOf } from '$lib/i18n/server/person-id'
import { getLocalePreferencePort } from '$lib/i18n/server/locale-preference-port'

export const actions = {
  locale: (event) =>
    switchLocale(event, {
      personIdOf: (locals) => personIdOf(locals as App.Locals),
      customerIdOf: (locals) => (locals as App.Locals).tenant?.id ?? null,
      port: getLocalePreferencePort
    })
} satisfies Actions
