// B4a-news-posts-ownership — the content-owned creation migration for news_posts.
//
// The file lives in the kernel repo at modules/content/app/migrations/ — the
// content module's APP chain, beside the content leaf's own chain in
// modules/content/migrations/ (TASK-200 Q7: the leaf's prebuild hashes
// ../migrations/*.sql, so leaving 1200 there would pull it into the leaf
// manifest). It moved there bytes unchanged. It must NOT live in gremion-ui/migrations/: the
// kernel registry has only the core and governance manifests
// (manifests/index.generated.ts), so disabledModuleMigrationFiles has nothing to
// gate it with and a content-OFF kernel-only fresh init would create the table.
//
// Pure: filesystem reads only.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const KERNEL_MIGRATIONS_DIR = join(process.cwd(), 'migrations')
const CONTENT_MIGRATION = join(
  process.cwd(), '..', 'modules', 'content', 'app', 'migrations', '1200_content_news_posts.sql',
)

// Lifted VERBATIM from StuRaOS/gremion-ui/migrations/008_public_portal.sql:14-27
// at the frozen extraction source f276af5925abacdcfd05f6613fc11afff2d804c5 (B00).
// Pinned here because the kernel repo has no access to the StuRa tree at test time.
const LIFTED_DDL = `CREATE TABLE IF NOT EXISTS news_posts (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  body_html    TEXT NOT NULL DEFAULT '',
  author_id    TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_posts_published
  ON news_posts (published_at DESC)
  WHERE published_at IS NOT NULL;`

describe('1200_content_news_posts.sql — content owns news_posts (B4a)', () => {
  it('carries the StuRa 008:14-27 DDL verbatim', () => {
    expect(readFileSync(CONTENT_MIGRATION, 'utf-8')).toContain(LIFTED_DDL)
  })

  it('issues the public-reader GRANT 058 no longer issues, and aborts on a missing role', () => {
    const text = readFileSync(CONTENT_MIGRATION, 'utf-8')
    expect(text).toContain('GRANT SELECT ON public.news_posts TO gremion_public_reader')
    expect(text).toMatch(/RAISE\s+EXCEPTION/i)
  })

  it('records the frozen extraction source it was lifted from (B00)', () => {
    expect(readFileSync(CONTENT_MIGRATION, 'utf-8'))
      .toContain('f276af5925abacdcfd05f6613fc11afff2d804c5')
  })

  it('no file in the kernel migrations directory creates news_posts', () => {
    const creators = readdirSync(KERNEL_MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?news_posts/i
          .test(readFileSync(join(KERNEL_MIGRATIONS_DIR, f), 'utf-8')),
      )
    expect(creators).toEqual([])
  })
})
