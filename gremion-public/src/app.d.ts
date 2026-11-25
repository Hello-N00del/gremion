// gremion-public/src/app.d.ts
declare global {
  namespace App {
    // No session — this app is fully public
    interface Locals {
      /** TASK-062: resolved by i18nHandle (hooks.server.ts) from cookie ->
       *  Accept-Language -> 'de' (no person/tenant concept in this app),
       *  limited to the locales the pages are written in (CONTENT_LOCALES). */
      locale?: import('$lib/i18n/server/resolve-locale').Locale
      /** Set by a route whose portal database is absent: the hook marks the 404 with
       *  the x-gremion-portal header (lib/server/portal-absent.ts). */
      portalAbsent?: boolean
    }
  }
}

export {};
