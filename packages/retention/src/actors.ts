// packages/retention/src/actors.ts -- the TRD-147 actor scan: an audit actor is
// an identifier, never a name. Two halves:
//   * scanActorSchema: audit_log.user_id must be uuid-typed, or text carrying
//     the uuid CHECK (gremion-ui migration 0060), in the kernel-data chain;
//   * scanActorValues: any value written as an actor must be a lowercase uuid
//     (a person) or a `<token>-service` principal (a component, e.g. the audit
//     consumers' 'calendar-service').
// A free-text actor (a display name, an e-mail address) would turn the audit
// store into a personal-data store that no pseudonymisation covers.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A component's fixed audit actor. Never a person: no capitals, no spaces, no '@'. */
export const SERVICE_ACTOR_RE = /^[a-z][a-z0-9]{1,30}-service$/

/** The spool field allow-list (033-b shape): the only keys a shipped log line may carry for a person. */
export const ACTOR_FIELD_ALLOWLIST: readonly string[] = ['user_id', 'actor_id', 'tenant_id']

export interface ActorFinding {
  where: string
  value: string
  problem: string
}

export function scanActorValues(where: string, values: readonly string[]): ActorFinding[] {
  const out: ActorFinding[] = []
  for (const value of values) {
    if (!UUID_RE.test(value) && !SERVICE_ACTOR_RE.test(value)) {
      out.push({ where, value: value.includes('@') ? '<address-like>' : value.slice(0, 40), problem: 'actor is neither a lowercase uuid nor a <token>-service principal' })
    }
  }
  return out
}

/**
 * Walks the kernel-data migrations (name -> sql text, in order) and returns the
 * findings for the audit_log actor column. GREEN needs a uuid column type or a
 * CHECK on user_id that pins the 8-4-4-4-12 hex pattern.
 */
export function scanActorSchema(migrations: ReadonlyArray<{ name: string; sql: string }>): ActorFinding[] {
  let uuidTyped = false
  let checked = false
  for (const { sql } of migrations) {
    if (/ALTER\s+TABLE\s+audit_log\s+ALTER\s+COLUMN\s+user_id\s+(?:SET\s+DATA\s+)?TYPE\s+uuid/i.test(sql)) uuidTyped = true
    if (/CREATE\s+TABLE[^;]*audit_log\s*\([^;]*user_id\s+uuid/i.test(sql)) uuidTyped = true
    // The WHOLE expression is pinned: the uuid form alone, or the uuid form OR the service form. An
    // `OR true` or any other alternative leaves the column free text and stays RED.
    const UUID = String.raw`'\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$'`
    const SERVICE = String.raw`'\^\[a-z\]\[a-z0-9\]\{1,30\}-service\$'`
    const check = new RegExp(String.raw`ALTER\s+TABLE\s+audit_log\s+ADD\s+CONSTRAINT\s+\w+\s+CHECK\s*\(\s*user_id\s*~\s*${UUID}(?:\s+OR\s+user_id\s*~\s*${SERVICE})?\s*\)`, 'i')
    if (check.test(sql)) checked = true
  }
  return uuidTyped || checked
    ? []
    : [{ where: 'audit_log.user_id', value: '', problem: 'column is free text: neither uuid-typed nor carrying the uuid CHECK' }]
}
