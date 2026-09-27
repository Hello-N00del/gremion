// Strict JSON: JSON.parse keeps the LAST of two equal keys and says nothing,
// so a token written with two `$value`s (UX-030 forbids it) would silently
// take the second. This scanner walks the raw text and reports every
// duplicate key with its dotted path before anything is parsed.

/**
 * @typedef {{ path: string, key: string }} DuplicateKey
 */

/**
 * Every key that appears twice in the same JSON object, in document order.
 * The text must be syntactically valid JSON (JSON.parse is the syntax gate).
 * @param {string} text
 * @returns {DuplicateKey[]}
 */
export function findDuplicateKeys(text) {
  /** @type {DuplicateKey[]} */
  const out = []
  let i = 0

  const ws = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i])) i++
  }
  const str = () => {
    // at opening quote
    let s = ''
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        s += text.slice(i, i + 2)
        i += 2
      } else {
        s += text[i]
        i++
      }
    }
    i++
    return JSON.parse(`"${s}"`)
  }
  /** @param {string[]} path */
  const value = (path) => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      /** @type {Set<string>} */
      const seen = new Set()
      ws()
      if (text[i] === '}') {
        i++
        return
      }
      for (;;) {
        ws()
        const key = str()
        if (seen.has(key)) out.push({ path: path.join('.'), key })
        seen.add(key)
        ws()
        i++ // ':'
        value([...path, key])
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        i++ // '}'
        return
      }
    }
    if (c === '[') {
      i++
      ws()
      if (text[i] === ']') {
        i++
        return
      }
      let n = 0
      for (;;) {
        value([...path, String(n++)])
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        i++ // ']'
        return
      }
    }
    if (c === '"') {
      str()
      return
    }
    // number / true / false / null
    while (i < text.length && !',}] \t\r\n'.includes(text[i])) i++
  }

  value([])
  return out
}

/**
 * JSON.parse that refuses duplicate keys.
 * @param {string} text
 * @param {string} source  a name for error messages
 * @returns {any}
 */
export function parseStrictJson(text, source) {
  const parsed = JSON.parse(text)
  const dups = findDuplicateKeys(text)
  if (dups.length > 0) {
    const where = dups.map((d) => `${d.path || '(root)'}: duplicate key "${d.key}"`).join('; ')
    throw new Error(`${source}: ${where}`)
  }
  return parsed
}
