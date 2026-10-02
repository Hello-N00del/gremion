// TASK-053 (L2-05, TRD-440/038): G-053-colour-suffix -- the ONE reference
// predicate for "no app-tier value names a first-party host without its colour
// suffix" (brief Q1). scripts/check-pooled-stack.mjs's colourSuffixViolations
// delegates here (grant G2); the render-guards verify suite calls it directly.
//
// LEAF MODULE on purpose: it imports nothing from check-pooled-stack.mjs or
// render/harness.mjs (check-pooled-stack imports THIS file, so the reverse edge
// would be an ESM cycle). It therefore declares its own first-party prefix; a
// test pins it equal to check-pooled-stack's FIRST_PARTY_IMAGE.
//
// The name set is DERIVED, never hand-listed:
//   - every service of an app render whose image starts with the first-party
//     prefix (a new first-party app service is covered the day it renders);
//   - every host of the form `<name>-${COLOUR}:` in an app.env.tmpl *_URL value
//     (the leaves the app tier talks to, which render nowhere in this repo).
// State, ops and mail renders never contribute: legal, vector, fallback and
// later matrix are colourless single instances, so `legal` referenced from the
// app tier is correct, not a violation.
//
// What counts as a HOST token (TASK-040's rule, kept):
//   - the URL authority right after `//` or `user@`;
//   - the whole value of a *HOST key (DB_HOST=gremion-ui is a host);
//   anything else is a name -- AUTH_KEYCLOAK_ID=gremion-ui is the OIDC client
//   id, which no colour owns.
// A token is claimed by the LONGEST derived name it equals or extends with
// `-...`, so `kernel-api-migrate-blue` is judged as kernel-api-migrate (+ -blue)
// and never as kernel-api (+ -migrate-blue).
import { readFileSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')

/** The first-party image prefix; pinned equal to FIRST_PARTY_IMAGE by a test. */
export const FIRST_PARTY_PREFIX = 'ghcr.io/hello-n00del/gremion-'
export const APP_ENV_TEMPLATE = path.join(REPO_ROOT, 'infra', 'host', 'templates', 'env', 'app.env.tmpl')
/** Fewer derived names than this and the predicate is judging nothing real. */
export const MIN_DERIVED_NAMES = 3

// ${COLOUR} in a template value is replaced by this token before host tokens
// are read, so `gremion-ui-${COLOUR}` is one token and a literal `-blue` in the
// template can never pass for it.
const COLOUR_PLACEHOLDER = 'zzcolourplaceholderzz'

/** Reads app.env.tmpl (the default template input of every caller). */
export function readAppTemplate(file = APP_ENV_TEMPLATE) {
  return readFileSync(file, 'utf8')
}

/** KEY=VALUE lines of an env file or template, with 1-based line numbers.
 * Comments and blank lines are skipped: a `# ... gremion-ui ...` comment is
 * prose, never a value. */
export function envLines(text) {
  const out = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(lines[i])
    if (m) out.push({ line: i + 1, key: m[1], value: m[2] })
  }
  return out
}

/** Service names of one render whose image carries the first-party prefix. */
export function imageDerivedNames(render, prefix = FIRST_PARTY_PREFIX) {
  return Object.entries(render?.services ?? {})
    .filter(([, svc]) => String(svc?.image ?? '').startsWith(prefix))
    .map(([name]) => name)
}

/**
 * Hosts app.env.tmpl names as `<name>-${COLOUR}:` in a *_URL value, plus the
 * `<x>-service` every `<X>_SERVICE_URL` KEY names. The key half exists because
 * the leaf hosts render nowhere in this repo: were the names read from the
 * suffixed VALUES alone, a line that lost its suffix would also drop its leaf
 * from the set the guard judges, and the guard would hide its own regression
 * (r2, 2026-09-29). A key cannot lose the suffix a value lost.
 */
export function templateDerivedNames(templateText) {
  const names = []
  for (const { key, value } of envLines(templateText)) {
    if (!key.endsWith('_URL')) continue
    const leaf = /^([A-Z0-9]+(?:_[A-Z0-9]+)*)_SERVICE_URL$/.exec(key)
    if (leaf) names.push(`${leaf[1].toLowerCase().replaceAll('_', '-')}-service`)
    for (const m of value.matchAll(/(?:\/\/|@)([a-z0-9][a-z0-9-]*?)-\$\{COLOUR\}:/g)) names.push(m[1])
  }
  return names
}

/** Unique, LONGEST FIRST (ties alphabetical, so the order is stable). */
export function longestFirst(names) {
  return [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length || a.localeCompare(b))
}

/**
 * The derived app-tier name set: the app renders' first-party services plus
 * the template's colour-suffixed hosts, plus any caller-passed extra names
 * (check-pooled-stack passes its APP_SERVICES + LEAF_SERVICES, keeping the
 * delegate a strict superset of the predicate it replaced).
 */
export function appTierServiceNames({ renders = [], templateText, extra = [] } = {}) {
  const text = templateText ?? readAppTemplate()
  return longestFirst([...renders.flatMap((r) => imageDerivedNames(r)), ...templateDerivedNames(text), ...extra])
}

/** Host tokens of one KEY=VALUE pair (see the file header). */
export function hostTokens(key, value) {
  const v = String(value ?? '')
  const tokens = []
  if (key.endsWith('HOST')) {
    const whole = /^([A-Za-z0-9-]+)/.exec(v)
    if (whole) tokens.push(whole[1])
  }
  for (const m of v.matchAll(/(?:\/\/|@)([A-Za-z0-9-]+)/g)) tokens.push(m[1])
  return tokens.map((t) => t.toLowerCase())
}

/** The longest derived name `token` equals or extends with `-...`, else null.
 * `names` must already be longest-first. */
export function claimingName(token, names) {
  for (const n of names) if (token === n || token.startsWith(`${n}-`)) return n
  return null
}

function environmentEntries(svc) {
  const env = svc?.environment ?? {}
  if (Array.isArray(env)) {
    return env.map((s) => {
      const str = String(s)
      const i = str.indexOf('=')
      return i < 0 ? [str, ''] : [str.slice(0, i), str.slice(i + 1)]
    })
  }
  return Object.entries(env)
}

/**
 * (b)+(c) over one app render: every environment value of every service.
 * Output strings are TASK-040's, unchanged (check-pooled-stack.test.mjs
 * matches them).
 */
export function renderColourViolations(render, colour, names, label = `app-${colour}`) {
  const ordered = longestFirst(names)
  const out = []
  for (const [svcName, svc] of Object.entries(render?.services ?? {})) {
    for (const [key, raw] of environmentEntries(svc)) {
      const value = String(raw ?? '')
      for (const token of hostTokens(key, value)) {
        const name = claimingName(token, ordered)
        if (name && token !== `${name}-${colour}`) {
          out.push(`${label}/${svcName}: environment.${key} names ${name} without the -${colour} suffix: ${value}`)
        }
      }
    }
  }
  return out
}

/** (b) over app.env.tmpl: every KEY=VALUE line (comments skipped) must name a
 * derived host only as `<name>-${COLOUR}`. */
export function templateColourViolations(templateText, names, label = 'app.env.tmpl') {
  const ordered = longestFirst(names)
  const want = (n) => `${n}-${COLOUR_PLACEHOLDER}`
  const out = []
  for (const { line, key, value } of envLines(templateText)) {
    const v = value.split('${COLOUR}').join(COLOUR_PLACEHOLDER)
    for (const token of hostTokens(key, v)) {
      const name = claimingName(token, ordered)
      if (name && token !== want(name)) {
        out.push(`${label}:${line}: ${key} names ${name} without the -\${COLOUR} suffix: ${value}`)
      }
    }
  }
  return out
}

/**
 * The whole G-053-colour-suffix guard, as the render-guards suite runs it.
 * `appRenders` is { <colour>: <app render> } -- the app-blue/app-green renders
 * ONLY; state/ops/mail never reach this function, so they cannot contribute a
 * name. `extra` is forwarded into the name set (the suite passes TASK-040's
 * APP_SERVICES + LEAF_SERVICES, the same union G2 uses): a second source the
 * template defect cannot erase. Returns the judged names (derived + extra),
 * the derived names alone, and one check per judged input.
 *
 * (d) vacuity is judged over the DERIVED names only (renders + template),
 * before `extra` is merged: the suite always passes 13 hand-listed extras, so
 * counting them would let a FIRST_PARTY_PREFIX drift or an empty template read
 * pass silently against the hand list alone (r3, 2026-09-29).
 */
export function colourSuffixGuard({ appRenders, templateText, extra = [] }) {
  const text = templateText ?? readAppTemplate()
  const derived = appTierServiceNames({ renders: Object.values(appRenders ?? {}), templateText: text })
  const vacuous = vacuityProblem(derived)
  const names = longestFirst([...derived, ...extra])
  const checks = Object.entries(appRenders ?? {}).map(([colour, render]) => ({
    id: `app-${colour}`,
    problems: [...(vacuous ? [vacuous] : []), ...renderColourViolations(render, colour, names, `app-${colour}`)],
  }))
  checks.push({ id: 'app.env.tmpl', problems: [...(vacuous ? [vacuous] : []), ...templateColourViolations(text, names)] })
  return { names, derived, checks }
}

/** (d): a name set this small means the derivation read nothing real. */
export function vacuityProblem(names, label = 'colour-suffix') {
  return names.length < MIN_DERIVED_NAMES
    ? `${label}: only ${names.length} app-tier name(s) derived (${names.join(', ') || 'none'}); fewer than ${MIN_DERIVED_NAMES} is vacuous`
    : null
}
