// src/lib/server/migrations-readme.test.ts
// P2.1b T12 (§7.5) — the migrations README is the source-of-truth doc for how
// data-plane migrations are applied; since P2.1a/b they are applied PER TENANT
// by the fleet runner. Pin that the written expand/contract tenet and the
// fleet/skip-logic/numbering notes exist, so the doc cannot silently drift
// away from the multi-tenant runner it describes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('migrations/README.md — multi-tenant migration rules (§7.5)', () => {
  // process.cwd() during `pnpm test:unit` is the gremion-ui package root — the
  // same anchor the runner uses for `migrations/` (see control-migrations.test.ts).
  const readme = readFileSync(join(process.cwd(), 'migrations', 'README.md'), 'utf-8')

  it('has the "Multi-tenant migration rules" section', () => {
    expect(readme).toMatch(/^## Multi-tenant migration rules/m)
  })

  it('writes the expand/contract tenet, including the never-destructive-in-the-same-release rule', () => {
    expect(readme).toMatch(/expand\/contract/i)
    expect(readme).toContain('Never ship a destructive change')
  })

  it('documents the fleet-runner semantics (per-tenant apply + control ledger)', () => {
    expect(readme).toContain('runFleetMigrations')
    expect(readme).toContain('tenant_migration_run')
    expect(readme).toContain('runWithTenant')
  })

  it('documents the per-tenant module skip-logic (skip and record nowhere)', () => {
    expect(readme).toContain('disabledModuleMigrationFiles')
    expect(readme).toContain('moduleReenableCatchup')
  })

  it('carries the 037/038/039 numbering-gap note and points at the separate control-plane chain', () => {
    for (const n of ['037', '038', '039', '040']) expect(readme).toContain(n)
    expect(readme).toContain('migrations-control')
  })
})

// B4a-news-posts-ownership — the README is the source-of-truth doc for how
// data-plane migrations are applied, so the kernel-guaranteed / module-owned
// table split has to be written there, not only in 058's comments.
describe('migrations/README.md — table ownership (B4a)', () => {
  const readme = readFileSync(join(process.cwd(), 'migrations', 'README.md'), 'utf-8')

  it('has the "Table ownership" section', () => {
    // ### (not ##): moved under "## Multi-tenant migration rules", right after
    // "### Cross-cutting module tables" and BEFORE "## What is here, what is
    // not" — hygiene check n2 reads everything from that inventory heading to
    // "### Migrations that exist in the product and not here" as the "absent"
    // list, so a table-ownership section placed after it that names shipped
    // files (008, 058, 003, 007, 010, 055) got misread as calling them absent.
    expect(readme).toMatch(/^### Table ownership: kernel-guaranteed vs module-owned/m)
  })

  it('names the content-owned creation migration and the reader role', () => {
    expect(readme).toContain('1200_content_news_posts.sql')
    expect(readme).toContain('gremion_public_reader')
    // Where it lives (TASK-200 Q7): the content APP chain, not the leaf chain.
    expect(readme).toContain('modules/content/app/migrations/')
  })

  it('states the content-OFF rule the split exists for', () => {
    expect(readme).toContain('content-OFF')
    expect(readme).toContain('0058_public_reader_grants.sql')
  })
})
