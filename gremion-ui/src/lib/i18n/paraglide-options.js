// TASK-062 (TRD-412): the one place the Paraglide compiler options live.
// vite.config.ts hands them to paraglideVitePlugin (dev, build, vitest) and
// compile.js hands them to compile() for `pnpm check`, which runs svelte-check
// without a Vite build and would otherwise see no generated modules.
//
// strategy: Paraglide 2.25 evaluates EVERY custom server strategy before ANY
// built-in one (runtime/extract-locale-from-request-async.js), so the brief's
// order (person -> cookie -> Accept-Language -> customer default -> 'de')
// cannot be spread over `custom-person`, `cookie`, `preferredLanguage`,
// `custom-customer`: the customer default would jump ahead of the cookie and
// the header. One custom strategy therefore carries the whole cascade
// (server/resolve-locale.ts), registered on the server by server/i18n-handle.ts
// and on the client by index.ts, where it reads back the `lang` the server
// rendered, so the client can never pick a different locale than the SSR did.
// `baseLocale` is the terminal fallback Paraglide requires.

/** @type {{ project: string, outdir: string, strategy: ['custom-gremion', 'baseLocale'], emitGitIgnore: boolean, emitPrettierIgnore: boolean, emitReadme: boolean }} */
const options = {
  project: './src/lib/i18n/project.inlang',
  outdir: './src/lib/i18n/paraglide',
  strategy: ['custom-gremion', 'baseLocale'],
  emitGitIgnore: true,
  emitPrettierIgnore: false,
  emitReadme: false
}

export default options
