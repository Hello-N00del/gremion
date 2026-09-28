// TASK-062 (TRD-412): the inlang import plugin for this app's catalogue.
//
// Why a local plugin instead of the stock `plugin-message-format` URL: the
// inlang SDK fetches every `http…` module in settings.json over the network on
// EVERY compile ("network-first", sdk plugin/cache.js), so the stock setup
// makes `vite build`, `vitest` and the Docker image build depend on a CDN.
// A local path is read from disk instead (loadProjectFromDirectory →
// importLocalPlugins), and `@inlang/paraglide-js` stays the only i18n
// dependency (brief §1 post-condition 5).
//
// The format is deliberately the flat subset of inlang's message format: one
// JSON object per locale, `"dotted.key": "text"`, with optional `{name}`
// placeholders. Keys keep the legacy `$t` names (brief §4), so the compiled
// messages are reachable as `m['nav.files']` (Q5: Paraglide 2 exports a
// non-identifier bundle id under its string name).
//
// Loaded through a data: URL, so this module must stay self-contained: no
// imports.

const PLUGIN_KEY = 'plugin.gremion.flatJson'
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * @param {string} text
 * @returns {{ pattern: Array<Record<string, unknown>>, names: string[] }}
 */
function parsePattern(text) {
  /** @type {Array<Record<string, unknown>>} */
  const pattern = []
  /** @type {string[]} */
  const names = []
  let last = 0
  for (const match of text.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0
    if (index > last) pattern.push({ type: 'text', value: text.slice(last, index) })
    const name = /** @type {string} */ (match[1])
    pattern.push({ type: 'expression', arg: { type: 'variable-reference', name } })
    if (!names.includes(name)) names.push(name)
    last = index + match[0].length
  }
  if (last < text.length || pattern.length === 0) pattern.push({ type: 'text', value: text.slice(last) })
  return { pattern, names }
}

const plugin = {
  key: PLUGIN_KEY,

  /** @param {{ settings: Record<string, any> }} args */
  toBeImportedFiles: async ({ settings }) => {
    const pathPattern = settings[PLUGIN_KEY]?.pathPattern
    if (typeof pathPattern !== 'string') {
      throw new Error(`${PLUGIN_KEY}.pathPattern must be a string in project.inlang/settings.json`)
    }
    return settings.locales.map((/** @type {string} */ locale) => ({
      locale,
      path: pathPattern.replace('{locale}', locale)
    }))
  },

  /** @param {{ files: Array<{ locale: string, content: Uint8Array }> }} args */
  importFiles: async ({ files }) => {
    /** @type {Map<string, { id: string, declarations: Array<{ type: string, name: string }> }>} */
    const bundles = new Map()
    const messages = []
    const variants = []
    for (const file of files) {
      const json = JSON.parse(new TextDecoder().decode(file.content))
      if (json === null || typeof json !== 'object' || Array.isArray(json)) {
        throw new Error(`${PLUGIN_KEY}: the ${file.locale} catalogue must be a flat JSON object`)
      }
      for (const [key, value] of Object.entries(json)) {
        if (key === '$schema') continue
        if (typeof value !== 'string') {
          throw new Error(`${PLUGIN_KEY}: ${file.locale} "${key}" must be a string (flat catalogue)`)
        }
        const { pattern, names } = parsePattern(value)
        const bundle = bundles.get(key) ?? { id: key, declarations: [] }
        for (const name of names) {
          if (!bundle.declarations.some((d) => d.name === name)) {
            bundle.declarations.push({ type: 'input-variable', name })
          }
        }
        bundles.set(key, bundle)
        messages.push({ bundleId: key, locale: file.locale, selectors: [] })
        variants.push({ messageBundleId: key, messageLocale: file.locale, matches: [], pattern })
      }
    }
    return { bundles: [...bundles.values()], messages, variants }
  }
}

export default plugin
