// P2.3 (#202) T3 — the pure blueprint registry.
//
// A non-default tenant must be fed ITS OWN blueprint at seed time. The registry
// row carries a `blueprintRef` string (set at provision via the `--blueprint`
// flag, defaulting to STURA); this map turns that ref back into a concrete
// seedable artifact. Keeping it a small data map — keyed by ref, not by slug or
// vertical — keeps "blueprint is data, selected by ref" honest and avoids a
// premature 3rd-vertical generalization (YAGNI, P2.3 design §"Out of scope").
//
// Unknown refs THROW loudly: a non-resolvable ref MUST NOT silently fall through
// to StuRa (that is exactly the cross-tenant data-leak the per-tenant seed path
// exists to prevent).
import type { GremionBlueprint } from './org-blueprint'
import { STURA_BLUEPRINT } from './org-blueprint'
import { MUNICIPAL_BLUEPRINT } from './municipal-blueprint'

/** The default tenant's blueprint ref (register-default.ts + pipeline INSERT). */
export const DEFAULT_BLUEPRINT_REF = 'STURA_BLUEPRINT@1' as const

/** Ref → seedable blueprint. Extend this map when a new vertical's blueprint is
 *  promoted to a seedable artifact (and bump the `@N` when its shape changes). */
const BLUEPRINTS: Readonly<Record<string, GremionBlueprint>> = {
  'STURA_BLUEPRINT@1': STURA_BLUEPRINT,
  'MUNICIPAL_BLUEPRINT@1': MUNICIPAL_BLUEPRINT,
}

/** Resolve a registry `blueprintRef` to its seedable blueprint, or THROW on an
 *  unknown ref (never silently default to StuRa). */
export function resolveBlueprint(ref: string): GremionBlueprint {
  const bp = BLUEPRINTS[ref]
  if (!bp) {
    throw new Error(
      `unknown blueprint ref "${ref}" — known refs: ${Object.keys(BLUEPRINTS).join(', ')}`,
    )
  }
  return bp
}
