// names.ts — every name the emitter writes: the file, the routers, the two
// in-file middlewares. One module so the name contract (spec B AM-B-07) has one
// spelling, and so the slug that reaches a filesystem path is validated in ONE
// place before it does.
//
// The slug names a file under etc/edge, so it is the one caller-supplied string
// that reaches a PATH. It is held to the tenant-slug alphabet gremion-ui
// enforces (^[a-z0-9-]{1,30}$ — no dot, no slash, no backslash, so no `..` and
// no separator can ever be spelled) and re-checked by emit.ts against the
// resolved path itself. The package deliberately does not import gremion-ui
// (brief §3), so the pattern is restated here; test/names.test.ts pins the two
// patterns equal by reading gremion-ui's slug.ts as text.

/** The tenant-slug alphabet, identical to gremion-ui's SLUG_PATTERN. */
export const SLUG_PATTERN = /^[a-z0-9-]{1,30}$/

/**
 * Slugs that would spell a PLATFORM middleware name. The four platform pins are
 * `edge-hostpin-{apex,www,control,sales}@docker`; a tenant `apex` would emit
 * `edge-hostpin-apex@file` — a different provider, so not a Traefik conflict,
 * but two objects one character-class apart that every reader, grep and
 * failure message would confuse. `control` is already reserved by gremion-ui.
 */
export const PLATFORM_PIN_LABELS: readonly string[] = Object.freeze(['apex', 'www', 'control', 'sales'])

export type SlugResult = { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly reason: string }

export function validateSlug(input: unknown): SlugResult {
  if (typeof input !== 'string' || !SLUG_PATTERN.test(input)) {
    return { ok: false, reason: 'slug must match ^[a-z0-9-]{1,30}$' }
  }
  if (PLATFORM_PIN_LABELS.includes(input)) {
    return { ok: false, reason: `slug "${input}" would spell a platform host-pin name` }
  }
  return { ok: true, slug: input }
}

/** Throws on an invalid slug; returns it unchanged otherwise. */
export function assertSlug(input: unknown, where: string): string {
  const v = validateSlug(input)
  if (!v.ok) throw new Error(`${where}: invalid slug ${JSON.stringify(input)}: ${v.reason}`)
  return v.slug
}

/** `tenant-<slug>.yml` — the one file a tenant owns under etc/edge. */
export function routerFileName(slug: string): string {
  return `tenant-${assertSlug(slug, 'routerFileName')}.yml`
}

/** Matches exactly the file names this package owns (and may therefore delete). */
export const ROUTER_FILE_RE = /^tenant-([a-z0-9-]{1,30})\.yml$/

function suffix(index: number, where: string): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`${where}: index must be a non-negative integer, got ${index}`)
  return index === 0 ? '' : `-${index}`
}

/** `tenant-<slug>` for the first host, `tenant-<slug>-<i>` for each further one. */
export function routerName(slug: string, index: number): string {
  return `tenant-${assertSlug(slug, 'routerName')}${suffix(index, 'routerName')}`
}

/** `edge-hostpin-<slug>` at index 0, `edge-hostpin-<slug>-<i>` after (AM-B-07). */
export function hostPinName(slug: string, index: number): string {
  return `edge-hostpin-${assertSlug(slug, 'hostPinName')}${suffix(index, 'hostPinName')}`
}

/** `edge-perip-<slug>` — one per tenant file, chained last by every router in it. */
export function perIpName(slug: string): string {
  return `edge-perip-${assertSlug(slug, 'perIpName')}`
}
