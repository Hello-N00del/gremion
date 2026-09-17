// gremion-public/src/lib/server/public-db.beschluesse.test.ts
// #320 Phase 3 — public structured Beschluss register query. We capture the
// static SQL the query function builds (the postgres tagged-template chunks,
// same pattern as public-db.visibility.test.ts) and assert:
//   * only resolutions of published protocols in all_members committees cross
//     the anonymous boundary,
//   * challenge state crosses ONLY as a count/exists flag over open challenges
//     (count-only angefochten — never substance or attribution),
//   * the optional committee filter degrades via the isUuid guard (#262 D5).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// PORT ADAPTATION (B5): the frozen source mocked the pre-rename env name
// STURA_PUBLIC_DB_URL; the kernel's public-db reads GREMION_PUBLIC_DB_URL
// (same name public-db.visibility.test.ts mocks).
vi.mock('$env/dynamic/private', () => ({
  env: { GREMION_PUBLIC_DB_URL: 'postgres://mock:mock@localhost/mock' },
}));

// Record the static SQL text of each tagged-template call. The first argument
// to a tagged template is the array of literal chunks; interpolated values land
// between them, so joining the chunks reconstructs the static query skeleton
// (which is where the literal filters live). We additionally record the
// interpolated values so the isUuid degradation is observable.
const sqlCalls: string[] = [];
const sqlValues: unknown[][] = [];
vi.mock('postgres', () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (Array.isArray(strings)) {
        sqlCalls.push(strings.join(' ? '));
        sqlValues.push(values);
      }
      return Promise.resolve([]);
    },
    { unsafe: () => Promise.resolve([]), end: () => Promise.resolve() }
  );
  return { default: () => sql };
});

import { getPublicBeschluesse } from './public-db.js';
import type { PublicBeschluss } from '@gremion/db/public-types';

const lastSql = () => sqlCalls[sqlCalls.length - 1];
const lastValues = () => sqlValues[sqlValues.length - 1];

describe('getPublicBeschluesse — public structured Beschluss register', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
    sqlValues.length = 0;
  });

  it('restricts to published protocols of all_members committees', async () => {
    await getPublicBeschluesse();
    const sql = lastSql();
    expect(sql).toMatch(/p\.status\s*=\s*'published'/);
    expect(sql).toMatch(/c\.visibility\s*=\s*'all_members'/);
  });

  it('projects challenge state as a count/exists flag over OPEN challenges only', async () => {
    await getPublicBeschluesse();
    const sql = lastSql();
    // a challenge subexpression filtered to open challenges …
    expect(sql).toMatch(/status\s*=\s*'open'/);
    // … producing a count or exists flag
    expect(sql).toMatch(/\b(COUNT|EXISTS)\s*\(/i);
  });

  it('never projects challenge substance or personal attribution', async () => {
    await getPublicBeschluesse();
    const sql = lastSql();
    // count-only angefochten: no grounds text, no challenger, no decider, no
    // decision reasoning may appear anywhere in the query.
    expect(sql).not.toMatch(/\bgrounds\b/i);
    expect(sql).not.toMatch(/\braised_by\b/i);
    expect(sql).not.toMatch(/\bdecided_by\b/i);
    expect(sql).not.toMatch(/\bdecision_note\b/i);
  });

  it('projects the public register fields', async () => {
    await getPublicBeschluesse();
    const sql = lastSql();
    expect(sql).toMatch(/r\.global_nr/);
    expect(sql).toMatch(/r\.text/);
    expect(sql).toMatch(/r\.result/);
    expect(sql).toMatch(/r\.decided_at/);
    expect(sql).toMatch(/r\.adoption_mode/);
    // the three nullable tallies (all-NULL is legal for acclamation rows)
    expect(sql).toMatch(/r\.votes_yes/);
    expect(sql).toMatch(/r\.votes_no/);
    expect(sql).toMatch(/r\.votes_abstain/);
  });

  it('applies a valid committee filter alongside the visibility gate', async () => {
    const uuid = '00000000-0000-0000-0000-000000000000';
    await getPublicBeschluesse(uuid);
    const sql = lastSql();
    expect(sql).toMatch(/c\.visibility\s*=\s*'all_members'/);
    expect(sql).toMatch(/p\.committee_id\s*=/);
    expect(lastValues()).toContain(uuid);
  });

  it('degrades a non-UUID committee filter to "no filter" (isUuid guard, #262 D5)', async () => {
    const garbage = "x'); DROP TABLE protocol_resolutions; --";
    await getPublicBeschluesse(garbage);
    // The raw string must never reach the ::uuid cast — the guard nulls it out
    // so garbage input degrades to the unfiltered query instead of a 500.
    expect(lastValues()).not.toContain(garbage);
  });

  it('resolves rows typed as PublicBeschluss', async () => {
    const rows: PublicBeschluss[] = await getPublicBeschluesse();
    expect(rows).toEqual([]);
  });
});
