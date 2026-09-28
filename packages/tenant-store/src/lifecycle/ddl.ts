// packages/tenant-store/src/lifecycle/ddl.ts
//
// Utility statements (CREATE/DROP DATABASE, CREATE/ALTER ROLE, GRANT, REVOKE)
// take no bind parameters, so their identifiers must be spliced into the
// text. They are spliced by the SERVER: format('%I') quotes an identifier and
// format('%L') a literal, exactly as PostgreSQL itself would, and the result is
// executed as one statement. The lifecycle never builds such a statement with
// string concatenation, and every identifier was validated first (guards.ts).
import type { Sql } from '@gremion/db'

/** format(template, ...args) evaluated by PostgreSQL. */
export async function serverFormat(sql: Sql, template: string, args: readonly string[]): Promise<string> {
  const placeholders = args.map((_, i) => `$${i + 2}::text`).join(', ')
  const rows = await sql.unsafe<{ stmt: string }[]>(`SELECT format($1::text${placeholders ? `, ${placeholders}` : ''}) AS stmt`, [template, ...args])
  const stmt = rows[0]?.stmt
  if (typeof stmt !== 'string' || stmt === '') throw new Error(`format(${JSON.stringify(template)}) returned no statement`)
  return stmt
}

/** Formats on the server, then executes the one resulting statement. */
export async function execFormatted(sql: Sql, template: string, args: readonly string[]): Promise<void> {
  await sql.unsafe(await serverFormat(sql, template, args))
}

/** SQLSTATE of a postgres-js error, if any. */
export function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
