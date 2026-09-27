// UX-031 tier lint: core -> semantic -> component, aliases point downward only.
//
// Rules (each violation names its rule, the offending token and the target):
//   unknown-tier            a top-level group that is not core/semantic/component
//   raw-value-outside-core  a semantic or component token whose $value is not a
//                           whole-value alias (only core holds raw values)
//   component-to-core       a component token aliasing a core token directly
//   upward-alias            core -> semantic/component, or semantic -> component
//   unknown-alias           an alias to a token that does not exist; resolution
//                           never falls back to a raw value
import { TIERS, aliasTarget, aliasesIn, flatten, mergeDocs, tierOf } from './model.js'

/**
 * @typedef {{ rule: string, path: string, target?: string, message: string }} TierViolation
 */

const RANK = { component: 0, semantic: 1, core: 2 }

/**
 * @param {Record<string, any>} doc  the document (or mode set) to lint
 * @param {{ against?: Record<string, any> }} [opts]  a mode set is linted with
 *   its aliases resolved against `against` merged with itself
 * @returns {TierViolation[]}
 */
export function lintTiers(doc, opts = {}) {
  /** @type {TierViolation[]} */
  const out = []
  for (const key of Object.keys(doc)) {
    if (key.startsWith('$')) continue
    if (!(/** @type {readonly string[]} */ (TIERS).includes(key))) {
      out.push({ rule: 'unknown-tier', path: key, message: `top-level group "${key}" is not one of ${TIERS.join('/')}` })
    }
  }
  const own = flatten(doc)
  const universe = opts.against ? flatten(mergeDocs(opts.against, doc)) : own
  for (const tok of own.values()) {
    const tier = tierOf(tok.path)
    if (!tier) continue // reported above as unknown-tier
    if (tier !== 'core' && aliasTarget(tok.value) === null) {
      out.push({
        rule: 'raw-value-outside-core',
        path: tok.path,
        message: `${tok.path} (${tier}) holds a raw value; only core tokens hold raw values, ${tier} tokens alias`,
      })
    }
    for (const target of aliasesIn(tok.value)) {
      if (!universe.has(target)) {
        out.push({ rule: 'unknown-alias', path: tok.path, target, message: `${tok.path} aliases {${target}}, which does not exist` })
        continue
      }
      const tt = tierOf(target)
      if (!tt) continue
      if (tier === 'component' && tt === 'core') {
        out.push({
          rule: 'component-to-core',
          path: tok.path,
          target,
          message: `${tok.path} (component) aliases {${target}} (core) directly; alias a semantic token instead`,
        })
      } else if (RANK[/** @type {keyof typeof RANK} */ (tt)] < RANK[/** @type {keyof typeof RANK} */ (tier)]) {
        out.push({
          rule: 'upward-alias',
          path: tok.path,
          target,
          message: `${tok.path} (${tier}) aliases {${target}} (${tt}) upward; aliases point downward only`,
        })
      }
    }
  }
  return out
}
