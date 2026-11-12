// Turns what a person typed into a people search into the `search` value Keycloak's user list expects.
//
// Keycloak (GET /admin/realms/<realm>/users?search=...) splits the value on whitespace and requires every
// word to match one of username, e-mail, first name or last name, case-insensitively. How a word matches
// is part of the value itself:
//   word      the START of a field           (the default)
//   *word*    anywhere in a field            (`*` is the wildcard, also inside a word)
//   "word"    a whole field
// `%` and `_` are ordinary characters there. A value of `*` alone matches every user of the realm.
//
// A person looking for a colleague types a piece of a name or of an address, not its beginning, so every
// word is sent as `*word*`. The two characters with a meaning (`*` and `"`) are never passed on from the
// input: they separate words like a blank does, so a typed `*` cannot list the realm and a typed quote
// cannot switch to whole-field matching.

/** Words over this count are refused by the caller: each one is four more LIKE comparisons per user. */
export const SEARCH_MAX_WORDS = 8

/** The distinct words of a typed search term, lower-cased, without Keycloak's wildcard and quote characters. */
export function searchWords(raw: string): string[] {
  const words = raw
    .toLowerCase()
    .split(/[\s*"]+/)
    .filter((w) => w !== '')
  return [...new Set(words)]
}

/** The Keycloak `search` value that finds each word anywhere in a name or address. Expects `searchWords` output. */
export function infixSearch(words: readonly string[]): string {
  return words.map((w) => `*${w}*`).join(' ')
}
