// @vitest-environment node
// Guard: the portal-publish route must not claim a UNIQUE index on
// news_posts.content_origin_post_id that no migration creates. Migration 1202 adds the
// column WITHOUT an index (the expand lint refuses one until the first release tag), so
// a comment that says "the UNIQUE index ... prevents duplicates" misleads the next reader
// into dropping the lookup-then-insert in portal-callback.ts. If a later contract-phase
// migration does add the index, this guard goes quiet on its own.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function repoRoot(): string {
  let dir = HERE
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'modules', 'content', 'app', 'migrations'))) return dir
    dir = dirname(dir)
  }
  throw new Error(`no repo root with modules/content/app/migrations above ${HERE}`)
}

function migrationCreatesUniqueIndex(): boolean {
  const dir = join(repoRoot(), 'modules', 'content', 'app', 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .some((f) => {
      const sql = readFileSync(join(dir, f), 'utf-8')
      // Executable statements only: strip `--` comments so prose cannot satisfy the guard.
      const code = sql.replace(/--.*$/gm, '')
      return /CREATE\s+UNIQUE\s+INDEX[^;]*content_origin_post_id/i.test(code)
    })
}

describe('portal-publish route comments', () => {
  it('claims a UNIQUE index on content_origin_post_id only if a migration creates one', () => {
    const src = readFileSync(join(HERE, '+server.ts'), 'utf-8')
    const claimsUnique = /UNIQUE\s+index\s+on\s+news_posts\.content_origin_post_id|uniqueness\s+constraint\s+on\s+the\s+column/i.test(src)
    // Either the route makes no such claim, or a migration really creates the index.
    expect(!claimsUnique || migrationCreatesUniqueIndex()).toBe(true)
  })
})
