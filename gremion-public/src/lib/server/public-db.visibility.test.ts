// gremion-public/src/lib/server/public-db.visibility.test.ts
// #250 — assert the public DB layer never projects committee_only org units or
// their protocols across the anonymous boundary. We capture the static SQL the
// query functions build (the postgres tagged-template chunks) and assert the
// visibility filter is present.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
  env: { GREMION_PUBLIC_DB_URL: 'postgres://mock:mock@localhost/mock' },
}));

// Record the static SQL text of each tagged-template call. The first argument
// to a tagged template is the array of literal chunks; interpolated values land
// between them, so joining the chunks reconstructs the static query skeleton
// (which is where our literal `visibility = 'all_members'` filter lives).
const sqlCalls: string[] = [];
vi.mock('postgres', () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (Array.isArray(strings)) sqlCalls.push(strings.join(' ? '));
      return Promise.resolve([]);
    },
    { unsafe: () => Promise.resolve([]), end: () => Promise.resolve() }
  );
  return { default: () => sql };
});

import {
  getAllCommittees,
  getPublishedProtocols,
  getPublishedProtocolById,
} from './public-db.js';

const lastSql = () => sqlCalls[sqlCalls.length - 1];

describe('#250 — committee visibility never crosses the public boundary', () => {
  beforeEach(() => {
    sqlCalls.length = 0;
  });

  it('getAllCommittees filters to all_members and does not project the visibility column', async () => {
    await getAllCommittees();
    const sql = lastSql();
    expect(sql).toMatch(/visibility\s*=\s*'all_members'/);
    // The visibility tier must not appear in the SELECT projection.
    const projection = sql.slice(0, sql.search(/\bFROM\b/i));
    expect(projection).not.toMatch(/visibility/i);
  });

  it('getPublishedProtocols restricts to all_members committees', async () => {
    await getPublishedProtocols();
    expect(lastSql()).toMatch(/c\.visibility\s*=\s*'all_members'/);
  });

  it('getPublishedProtocols keeps the optional committee filter alongside the visibility gate', async () => {
    await getPublishedProtocols('00000000-0000-0000-0000-000000000000');
    const sql = lastSql();
    expect(sql).toMatch(/c\.visibility\s*=\s*'all_members'/);
    expect(sql).toMatch(/p\.committee_id\s*=/);
  });

  it('getPublishedProtocolById restricts to all_members committees', async () => {
    await getPublishedProtocolById('00000000-0000-0000-0000-000000000000');
    expect(lastSql()).toMatch(/c\.visibility\s*=\s*'all_members'/);
  });
});
