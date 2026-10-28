// @vitest-environment node
// TASK-033-a / TRD-147: audit_log.user_id carries the 0061 CHECK (a lowercase uuid
// or a <token>-service principal). A runtime writer must never invent a placeholder
// actor ('unknown', 'system', ...) when the session has no id: the INSERT would
// fail with 23514, and a writer that swallows the error (the erasure route's
// try/catch) would silently drop its audit row. The door (hooks.server.ts) refuses
// a session without `sub`, so `user.id` is always set where these writers run.
//
// RED recipe: put `?? 'unknown'` back into routes/api/settings/erasure/+server.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../', import.meta.url))

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (/\.(ts|svelte)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !/integration/.test(e.name)) out.push(p)
  }
  return out
}

describe('audit actors are never a literal fallback', () => {
  it('no source that writes the audit log or starts an erasure sets `userId: <expr> ?? <string literal>` or `requestedBy: <expr> ?? <string literal>`', () => {
    const offenders: string[] = []
    for (const f of sources(SRC)) {
      const text = readFileSync(f, 'utf8')
      if (!/writeAuditEntry|startErasure/.test(text)) continue
      if (/\b(?:userId|requestedBy)\s*:\s*[\w.?]+\s*(?:\?\?|\|\|)\s*['"`]/.test(text)) offenders.push(relative(SRC, f).replaceAll('\\', '/'))
    }
    expect(offenders).toEqual([])
  })
})
