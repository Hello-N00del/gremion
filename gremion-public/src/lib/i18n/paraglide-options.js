// TASK-062 (TRD-412): the one place the Paraglide compiler options live, the
// same shape as gremion-ui's (the two apps share no package).
// vite.config.ts hands them to paraglideVitePlugin (dev, build, vitest) and
// compile.js hands them to compile() for `pnpm check`, which runs svelte-check
// without a Vite build and would otherwise see no generated modules.
//
// strategy: Paraglide 2.25 evaluates EVERY custom server strategy before ANY
// built-in one (runtime/extract-locale-from-request-async.js), so a cascade
// cannot be spread over custom and built-in strategies in order. One custom
// strategy carries this app's cascade (server/resolve-locale.ts: cookie ->
// Accept-Language -> 'de'), registered by server/i18n-handle.ts. No client
// strategy yet: the portal renders no message in the browser; the first
// client-side message (TASK-161) adds one that reads back the SSR `lang`, as
// gremion-ui's index.ts does. `baseLocale` is the terminal fallback.

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
