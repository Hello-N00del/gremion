// TASK-062 (brief §3 grant: one new form action for the switch). The logic
// lives in $lib/i18n/server/switch-locale.ts; this file only binds its seams.
//
// Settings > Profil: two more form actions, both for the SIGNED-IN member only
// (the user id comes from locals.user, never from the request). Logic and tests
// live in $lib/server/profile; this file binds the seams.
import type { Actions } from './$types'
import { switchLocale } from '$lib/i18n/server/switch-locale'
import { personIdOf } from '$lib/i18n/server/person-id'
import { getLocalePreferencePort } from '$lib/i18n/server/locale-preference-port'
import { saveOwnName } from '$lib/server/profile/own-name'
import { startAccountAction } from '$lib/server/profile/account-actions'
import { accountActionDeps, ownNameDeps } from '$lib/server/profile/profile-panel'
import { signIn } from '../../auth'

export const actions = {
  locale: (event) =>
    switchLocale(event, {
      personIdOf: (locals) => personIdOf(locals as App.Locals),
      customerIdOf: (locals) => (locals as App.Locals).tenant?.id ?? null,
      port: getLocalePreferencePort
    }),
  // Own first and last name, saved through the Keycloak admin client.
  profileName: (event) => saveOwnName(event, ownNameDeps(event.locals.tenant)),
  // Starts a Keycloak application-initiated action (password, one-time code, e-mail) via the Auth.js sign-in.
  accountAction: (event) => startAccountAction(event, accountActionDeps(event.locals.tenant, signIn as never))
} satisfies Actions
