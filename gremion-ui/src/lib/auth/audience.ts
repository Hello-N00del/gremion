// Config-driven Bearer-JWT audiences (Pillar-1 P0.1). The audience list was
// hardcoded in jwt-verify.ts, blocking a second service from verifying tokens
// on the shared realm. This keeps the SAME default; a real second audience is
// only added when a real second consumer exists.
export const DEFAULT_AUDIENCES: readonly string[] = ['gremion-ui', 'gremion-mobile']

/** Parse a comma-separated AUTH_JWT_AUDIENCES value; fall back to the default. */
export function parseAudiences(raw: string | undefined): string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parsed.length > 0 ? parsed : [...DEFAULT_AUDIENCES]
}
