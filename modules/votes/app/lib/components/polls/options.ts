// The options textarea of the quick-poll form holds one option per line. Both the form (before it sends anything)
// and the create action (for a request that skipped the form's check) read it through here, so they agree on what
// counts as the same option: the trimmed line, compared exactly. A repeated line is refused with a message, so a
// person is never left to find it silently gone.

export interface ParsedPollOptions {
  /** Non-empty trimmed lines, in order, repeats removed (what the poll will hold). */
  options: string[]
  /** Each repeated line once, in the order its first repeat appears. */
  duplicates: string[]
}

export function parsePollOptions(raw: string | null | undefined): ParsedPollOptions {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  const options: string[] = []
  for (const line of (raw ?? '').split('\n')) {
    const option = line.trim()
    if (!option) continue
    if (seen.has(option)) {
      repeated.add(option)
      continue
    }
    seen.add(option)
    options.push(option)
  }
  return { options, duplicates: [...repeated] }
}

/** The German refusal for a repeated option, or null when every option is distinct. */
export function duplicateOptionMessage(duplicates: readonly string[]): string | null {
  if (duplicates.length === 0) return null
  const names = duplicates.map((d) => `„${d}“`).join(', ')
  return duplicates.length === 1
    ? `Die Option ${names} steht mehrfach in der Liste. Jede Option darf nur einmal vorkommen.`
    : `Die Optionen ${names} stehen mehrfach in der Liste. Jede Option darf nur einmal vorkommen.`
}
