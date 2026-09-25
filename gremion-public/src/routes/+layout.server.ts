// gremion-public/src/routes/+layout.server.ts
// Supplies global data: institution branding, main app URL.
//
// TASK-032 (TRD-410 [D R20-D5]): reads process.env directly. This used to
// read `$env/dynamic/public`, NOT `$env/dynamic/private` — SvelteKit's
// private dynamic env EXCLUDED every variable whose name starts with the
// public prefix, so reading `PUBLIC_*` from it silently yielded `undefined`
// (a real, previously-fixed bug here — see git history). Kit 3 made both
// dynamic-env modules expose only vars explicitly declared via
// `defineEnvVars` (nothing here is declared that way), so continuing to read
// either module would silently resolve every value below to `undefined`
// again. `process.env` has no public/private distinction to get wrong: this
// is a `.server.ts` file, so it never reaches the browser regardless of the
// `PUBLIC_` prefix's historical meaning for client-bundled code.
import type { LayoutServerLoad } from './$types';
import { resolveSourceUrl } from '$lib/source-offer';

export const load: LayoutServerLoad = async () => {
  return {
    // Product name lives in config (env), never hardcoded in components — and
    // never DEFAULTED to one either. This used to fall back to a specific
    // instance's product name, so every unconfigured deploy of the kernel
    // advertised somebody else's product in its portal chrome. An empty slot is
    // correct; a wrong name is not. `|| null` (not `??`) for the same reason as
    // the apex block below: compose's `${VAR:-}` substitutes an EMPTY STRING,
    // which `??` would happily pass through. `+layout.svelte` renders the
    // product chip only `{#if data.product}`.
    product:          process.env.PUBLIC_PRODUCT_NAME || null,
    institutionName:  process.env.PUBLIC_CONTACT_NAME ?? 'Studierendenrat',
    legislatureLabel: process.env.PUBLIC_LEGISLATURE_LABEL ?? null,
    mainAppUrl:       process.env.PUBLIC_MAIN_APP_URL ?? null,

    // AGPL-3.0 section 13: the running program must offer its Corresponding
    // Source. An operator who modified the program sets PUBLIC_SOURCE_URL to
    // their own repository — pointing at upstream would make the offer false.
    // Unset falls back to upstream (resolveSourceUrl), which is correct for an
    // unmodified deploy.
    sourceUrl:        resolveSourceUrl(process.env.PUBLIC_SOURCE_URL),

    // v12 (apex topology) — the optional back-route out of the portal and up to
    // a site ABOVE it (a landing / marketing site at the origin root). ALL of
    // these default to null and the chrome then renders nothing: a governance
    // kernel deployed on its own has no site above it, and a dangling link is
    // worse than no link. Label and copy are operator-supplied so no product's
    // naming is baked into the kernel's markup.
    //   PUBLIC_APEX_URL       — target, e.g. https://example.org or /
    //   PUBLIC_APEX_LABEL     — apex-strip text, e.g. the operator's host
    //   PUBLIC_APEX_NOTE      — optional second segment in the strip
    //   PUBLIC_APEX_COLOPHON  — footer colophon text (whole sentence)
    // `|| null`, not `?? null`: docker-compose's `${VAR:-}` substitutes an EMPTY
    // STRING for an unset variable, so `??` would hand the chrome `''` and only
    // truthiness checks downstream would save it. Normalise here instead.
    apexUrl:          process.env.PUBLIC_APEX_URL || null,
    apexLabel:        process.env.PUBLIC_APEX_LABEL || null,
    apexNote:         process.env.PUBLIC_APEX_NOTE || null,
    apexColophon:     process.env.PUBLIC_APEX_COLOPHON || null,
  };
};
