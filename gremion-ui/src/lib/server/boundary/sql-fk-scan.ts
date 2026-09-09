// P0.4 boundary-lint (design §3.1/§7): no NEW cross-schema FK between the
// finance and public (governance) schemas — in either direction. Unqualified
// REFERENCES targets resolve to `public` (Postgres default search_path), which
// is exactly how the three ratified kernel FKs are written in migration 013.
// Pure node module: no $lib aliases, no SvelteKit imports (tsx + vitest only).

export interface FkViolation {
  file: string
  line: number
  table: string // schema-qualified table being created/altered
  ref: string   // schema-qualified REFERENCES target after resolution
}

export interface FkAllowEntry { file: string; table: string; ref: string }

const STMT_TABLE_RE =
  /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+ONLY)?)\s+("?[A-Za-z_][A-Za-z0-9_]*"?(?:\."?[A-Za-z_][A-Za-z0-9_]*"?)?)/i
const REF_RE = /\bREFERENCES\s+("?[A-Za-z_][A-Za-z0-9_]*"?(?:\."?[A-Za-z_][A-Za-z0-9_]*"?)?)\s*\(/gi

function qualify(raw: string): { schema: string; name: string } {
  const clean = raw.replace(/"/g, '')
  const [a, b] = clean.split('.')
  return b ? { schema: a.toLowerCase(), name: b.toLowerCase() } : { schema: 'public', name: a.toLowerCase() }
}

/** Replace `-- …` comments with spaces of equal length so offsets/lines hold. */
function blankLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
}

export function scanSqlForCrossSchemaFk(
  file: string,
  sql: string,
  allow: FkAllowEntry[],
): FkViolation[] {
  const text = blankLineComments(sql)
  const out: FkViolation[] = []
  let offset = 0
  for (const stmt of text.split(';')) {
    const tm = STMT_TABLE_RE.exec(stmt)
    if (tm) {
      const target = qualify(tm[1])
      REF_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = REF_RE.exec(stmt)) !== null) {
        const ref = qualify(m[1])
        const cross =
          (target.schema === 'finance' && ref.schema === 'public') ||
          (target.schema === 'public' && ref.schema === 'finance')
        if (!cross) continue
        const v: FkViolation = {
          file,
          line: text.slice(0, offset + m.index).split('\n').length,
          table: `${target.schema}.${target.name}`,
          ref: `${ref.schema}.${ref.name}`,
        }
        const allowed = allow.some(
          (a) => (file === a.file || file.endsWith(`/${a.file}`)) && v.table === a.table && v.ref === a.ref,
        )
        if (!allowed) out.push(v)
      }
    }
    offset += stmt.length + 1 // +1 for the consumed ';'
  }
  return out
}
