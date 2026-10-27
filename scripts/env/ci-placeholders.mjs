/**
 * The CI placeholder values for compose's required (`:?`) variables, read from
 * compose/ci.placeholder.env -- the one file every render-only check shares.
 *
 * Render-only: a check that only reads the SHAPE of a compose render (published
 * ports, image names) needs the document to interpolate, not real secrets.
 * Nothing returned here is written anywhere. Callers apply a value only for a
 * variable the environment does not already carry, so a real value always wins.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CI_PLACEHOLDER_FILE = 'compose/ci.placeholder.env'

/**
 * Parses KEY=value lines (no quoting, no export, no interpolation: the file is a
 * flat list of literals). Comment and blank lines are skipped.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parsePlaceholderEnv(text) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/**
 * @param {string} [root] repo root (default: this script's own tree)
 * @returns {Record<string, string>}
 */
export function ciPlaceholderEnv(root = path.resolve(HERE, '..', '..')) {
  return parsePlaceholderEnv(readFileSync(path.join(root, CI_PLACEHOLDER_FILE), 'utf8'))
}

/**
 * `env` with every placeholder the environment does not already carry.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [root]
 * @returns {NodeJS.ProcessEnv}
 */
export function withCiPlaceholders(env, root) {
  const out = { ...env }
  for (const [k, v] of Object.entries(ciPlaceholderEnv(root)))
    if (out[k] === undefined || out[k] === '') out[k] = v
  return out
}
